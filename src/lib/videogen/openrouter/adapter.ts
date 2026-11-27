/**
 * OpenRouter's video API as data: the model list (`GET /v1/videos/models`),
 * what one model can do as `VideoCaps`, the job request, a job's state, and
 * what a clip will cost. No calls are made here; `./backend.ts` makes them.
 *
 * A model takes a length in whole seconds from a list, a resolution tier
 * (`720p`) and an aspect ratio, not frames and pixels. Its caps describe one
 * tier at a fixed 24 fps, so the tool's arithmetic (`fitClip`) works as for
 * any model, and a request is sent as the nearest length, tier and ratio. The
 * clip that comes back is probed for what it really is.
 */

import type { ModelOption } from '#lib/image/backend.ts';
import type { VideoCaps, VideoProgress } from '#lib/videogen/types.ts';

/** The frame rate a model's caps are described at; the real clip's is probed. */
export const CAPS_FPS = 24;

/** The length a clip gets when none is asked for. */
const DEFAULT_SECONDS = 5;

/** One model from `GET /v1/videos/models`: only the fields read here. */
export interface OpenRouterVideoModel {
	id: string;
	name: string;
	/** Whole seconds it makes, ascending; empty for a model that makes no clip from a prompt. */
	durations: number[];
	/** Tiers such as `720p` or `4K`, as listed. */
	resolutions: string[];
	/** `16:9` and the like; empty when it doesn't say. */
	ratios: string[];
	firstFrame: boolean;
	lastFrame: boolean;
	/** It makes a sound track. */
	audio: boolean;
	seed: boolean;
	/** `pricing_skus`, as numbers. */
	skus: Record<string, number>;
}

const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];

/** `pricing_skus` as numbers; a price that isn't one is left out. */
function skusOf(raw: unknown): Record<string, number> {
	const skus: Record<string, number> = {};
	if (!raw || typeof raw !== 'object') return skus;
	for (const [k, v] of Object.entries(raw)) {
		const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
		if (Number.isFinite(n)) skus[k] = n;
	}
	return skus;
}

/** Whole positive seconds, ascending; `-1` (automatic) and anything else are left out. */
function durationsOf(raw: unknown): number[] {
	const list = (Array.isArray(raw) ? raw : []).filter(
		(d): d is number => typeof d === 'number' && Number.isInteger(d) && d > 0
	);
	return [...new Set(list)].sort((a, b) => a - b);
}

/** The list's models; anything malformed is left out. */
export function parseVideoModels(payload: unknown): OpenRouterVideoModel[] {
	const rows = (payload as { data?: unknown } | null)?.data;
	if (!Array.isArray(rows)) return [];
	const out: OpenRouterVideoModel[] = [];
	for (const row of rows) {
		const r = (row ?? {}) as Record<string, unknown>;
		if (typeof r.id !== 'string' || !r.id) continue;
		const frames = strings(r.supported_frame_images);
		out.push({
			id: r.id,
			name: typeof r.name === 'string' && r.name ? r.name : r.id,
			durations: durationsOf(r.supported_durations),
			resolutions: strings(r.supported_resolutions),
			ratios: strings(r.supported_aspect_ratios),
			firstFrame: frames.includes('first_frame'),
			lastFrame: frames.includes('last_frame'),
			audio: r.generate_audio === true,
			seed: r.seed === true,
			skus: skusOf(r.pricing_skus)
		});
	}
	return out;
}

/**
 * Model families OpenRouter's docs name as taking `input_references`. The
 * model list has no field for it, so this list is all there is to go on; a
 * model that refuses them anyway is passed on (see `submit` in `./backend.ts`).
 */
const REFERENCE_FAMILIES = ['alibaba/wan-3', 'bytedance/seedance-2', 'runway/'];

/** `m` keeps the look of reference pictures, as far as anyone has said. */
export function takesReferences(m: OpenRouterVideoModel): boolean {
	return REFERENCE_FAMILIES.some((f) => m.id.startsWith(f));
}

/** The most reference pictures sent with one clip. */
export const MAX_REFERENCES = 3;

/**
 * The model makes a clip from a prompt here: it lists lengths and sizes. An
 * avatar, edit or upscale model lists neither and is left out.
 */
export function makesClips(m: OpenRouterVideoModel): boolean {
	return m.durations.length > 0 && m.resolutions.some((r) => shortSide(r) !== null);
}

/** The models Settings offers, by name. */
export function videoModelOptions(models: OpenRouterVideoModel[]): ModelOption[] {
	return models
		.filter(makesClips)
		.map((m) => ({ name: m.id, label: m.name }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** A tier's short side in pixels: `720p` is 720, `2K` 1440, `4K` 2160; null for anything else. */
export function shortSide(tier: string): number | null {
	const p = /^(\d+)p$/i.exec(tier);
	if (p) return Number(p[1]);
	const k = /^(\d+)k$/i.exec(tier);
	if (k) return ({ 2: 1440, 4: 2160 } as Record<string, number>)[k[1]] ?? null;
	return null;
}

/** The model's tiers this understands, smallest first. */
export function tiers(m: OpenRouterVideoModel): string[] {
	return m.resolutions
		.filter((r) => shortSide(r) !== null)
		.sort((a, b) => shortSide(a)! - shortSide(b)!);
}

/** The tier a clip is made at: `wanted` when listed, else 720p, else the smallest. */
export function tierOf(m: OpenRouterVideoModel, wanted?: string): string {
	const list = tiers(m);
	if (wanted && list.includes(wanted)) return wanted;
	return list.find((t) => t.toLowerCase() === '720p') ?? list[0] ?? '720p';
}

/** `"16:9"` as 16/9; null for anything else. */
function ratioOf(s: string): number | null {
	const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(s);
	if (!m) return null;
	const [w, h] = [Number(m[1]), Number(m[2])];
	return w > 0 && h > 0 ? w / h : null;
}

/** The listed ratio nearest `width` × `height`, or null when none is listed. */
export function nearestRatio(ratios: string[], width: number, height: number): string | null {
	const want = Math.log(width / height);
	let best: string | null = null;
	let gap = Infinity;
	for (const v of ratios) {
		const r = ratioOf(v);
		if (r === null) continue;
		const d = Math.abs(Math.log(r) - want);
		if (d < gap) [best, gap] = [v, d];
	}
	return best;
}

/** A tier and ratio in pixels: the tier's short side, the long side to the nearest even pixel. */
export function pixelSize(tier: string, ratio: string): { width: number; height: number } {
	const short = shortSide(tier) ?? 720;
	const r = ratioOf(ratio) ?? 16 / 9;
	const long = Math.round((short * Math.max(r, 1 / r)) / 2) * 2;
	return r >= 1 ? { width: long, height: short } : { width: short, height: long };
}

/** The ratio a landscape clip is described at: 16:9 when listed, else the widest landscape one, else the first. */
function landscapeRatio(m: OpenRouterVideoModel): string {
	if (m.ratios.length === 0 || m.ratios.includes('16:9')) return '16:9';
	const wide = m.ratios.filter((r) => (ratioOf(r) ?? 0) >= 1);
	return wide.sort((a, b) => ratioOf(a)! - ratioOf(b)!).at(-1) ?? m.ratios[0];
}

/** The listed length nearest `seconds`. */
function nearestDuration(m: OpenRouterVideoModel, seconds: number): number {
	return m.durations.reduce((a, b) => (Math.abs(b - seconds) < Math.abs(a - seconds) ? b : a));
}

/** What `m` can do and make at `tier`, as every video backend reports it. */
export function capsOf(m: OpenRouterVideoModel, tier: string): VideoCaps {
	const size = pixelSize(tier, landscapeRatio(m));
	const largest = tiers(m).at(-1) ?? tier;
	const most = pixelSize(largest, landscapeRatio(m));
	const longest = m.durations.at(-1) ?? DEFAULT_SECONDS;
	return {
		text: true,
		startImage: m.firstFrame,
		endImage: m.lastFrame,
		speech: false,
		needsSpeech: false,
		sound: m.audio,
		...(takesReferences(m) ? { references: true } : {}),
		limits: {
			defaultFps: CAPS_FPS,
			defaultFrames: nearestDuration(m, DEFAULT_SECONDS) * CAPS_FPS + 1,
			defaultSize: `${size.width}x${size.height}`,
			maxFrames: longest * CAPS_FPS + 1,
			maxSize: `${most.width}x${most.height}`,
			maxPixelFrames: null,
			fixedFps: CAPS_FPS
		},
		frameStep: 1,
		licence: '',
		commercialUse: null
	};
}

/** The length to ask for: the shortest listed that covers `frames` at `fps`, else the longest. */
export function durationFor(m: OpenRouterVideoModel, frames: number, fps: number): number {
	const seconds = fps > 0 ? (frames - 1) / fps : DEFAULT_SECONDS;
	return m.durations.find((d) => d >= seconds - 0.05) ?? m.durations.at(-1) ?? DEFAULT_SECONDS;
}

/** The listed tier whose short side is nearest the request's. */
export function resolutionFor(m: OpenRouterVideoModel, width: number, height: number): string {
	const want = Math.min(width, height);
	const list = tiers(m);
	return list.reduce(
		(a, b) => (Math.abs(shortSide(b)! - want) < Math.abs(shortSide(a)! - want) ? b : a),
		list[0] ?? '720p'
	);
}

/** What one clip is sent with. */
export interface ClipRequest {
	prompt: string;
	width: number;
	height: number;
	frames: number;
	fps: number;
	seed: number;
	/** Data URLs of the pictures to start and end on. */
	startUrl?: string;
	endUrl?: string;
	/** Data URLs of pictures whose look to keep. */
	referenceUrls?: string[];
}

/** The body of `POST /v1/videos` for `req` on `m`: only what `m` lists is sent. */
export function buildClipBody(m: OpenRouterVideoModel, req: ClipRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: m.id,
		prompt: req.prompt.trim(),
		duration: durationFor(m, req.frames, req.fps),
		resolution: resolutionFor(m, req.width, req.height)
	};
	const ratio = nearestRatio(m.ratios, req.width, req.height);
	if (ratio) body.aspect_ratio = ratio;
	if (m.audio) body.generate_audio = true;
	if (m.seed) body.seed = req.seed;
	const frames = [
		...(req.startUrl && m.firstFrame ? [{ url: req.startUrl, frame_type: 'first_frame' }] : []),
		...(req.endUrl && m.lastFrame ? [{ url: req.endUrl, frame_type: 'last_frame' }] : [])
	];
	if (frames.length > 0) {
		body.frame_images = frames.map((f) => ({
			type: 'image_url',
			image_url: { url: f.url },
			frame_type: f.frame_type
		}));
	}
	const refs = takesReferences(m) ? (req.referenceUrls ?? []).slice(0, MAX_REFERENCES) : [];
	if (refs.length > 0) {
		body.input_references = refs.map((url) => ({ type: 'image_url', image_url: { url } }));
	}
	return body;
}

/** A job, as a poll describes it. */
export interface ClipJob {
	id: string;
	status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
	/** `queued_at_provider`, `generating`, `finalizing`, …; empty when it doesn't say. */
	detail: string;
	/** Percent done, from a provider that says. */
	progress: number | null;
	error: string | null;
	/** What it cost, in US dollars, once it says. */
	cost: number | null;
}

const STATUSES: ClipJob['status'][] = [
	'pending',
	'in_progress',
	'completed',
	'failed',
	'cancelled',
	'expired'
];

export function readClipJob(payload: unknown): ClipJob | null {
	const j = (payload ?? {}) as Record<string, unknown>;
	if (typeof j.id !== 'string' || !j.id) return null;
	const status = STATUSES.includes(j.status as ClipJob['status'])
		? (j.status as ClipJob['status'])
		: 'pending';
	const err = j.error as { message?: unknown } | string | null | undefined;
	const error =
		typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : null;
	const cost = (j.usage as { cost?: unknown } | undefined)?.cost;
	return {
		id: j.id,
		status,
		detail: typeof j.status_detail === 'string' ? j.status_detail : '',
		progress: typeof j.progress === 'number' && Number.isFinite(j.progress) ? j.progress : null,
		error: error || null,
		cost: typeof cost === 'number' && Number.isFinite(cost) ? cost : null
	};
}

/** The job has ended, one way or another. */
export const ended = (j: ClipJob) => j.status !== 'pending' && j.status !== 'in_progress';

export function clipProgressOf(j: ClipJob): VideoProgress {
	if (j.status === 'pending') return { phase: j.detail === 'submitting' ? 'starting' : 'queued' };
	if (j.detail === 'finalizing') return { phase: 'saving' };
	return {
		phase: 'generating',
		...(j.progress !== null ? { step: Math.round(j.progress), totalSteps: 100 } : {})
	};
}

/** A per-second price key's parts: its resolution and whether it has sound, when it says. */
function rateKey(
	key: string
): { tier: string | null; audio: boolean | null; cents: boolean } | null {
	const m =
		/^(duration_seconds|cents_per_video_output_second|cents_per_second_output)((?:_[a-z0-9]+)*)$/i.exec(
			key
		);
	if (!m) return null;
	const rest = m[2];
	const audio = /_with_audio/.test(rest) ? true : /_without_audio/.test(rest) ? false : null;
	const last = rest.split('_').at(-1) ?? '';
	const tier = shortSide(last) !== null ? last.toLowerCase() : null;
	// Anything else in the name (`_video_input`) is a price for something this doesn't send.
	const left = rest
		.replace(/_with_audio|_without_audio/, '')
		.replace(tier ? new RegExp(`_${tier}$`, 'i') : /$^/, '');
	if (left) return null;
	return { tier, audio, cents: m[1].startsWith('cents') };
}

/**
 * The price that applies of `found`: the tier's own, else the one with no
 * tier (OpenRouter's rule); with sound or without as asked, else either.
 */
function pick<T extends { tier: string | null; audio: boolean | null; usd: number }>(
	found: T[],
	tier: string,
	audio: boolean
): number | null {
	const want = tier.toLowerCase();
	const atTier = found.filter((f) => f.tier === want);
	const pool = atTier.length > 0 ? atTier : found.filter((f) => f.tier === null);
	const same = pool.filter((f) => f.audio === audio);
	const any = same.length > 0 ? same : pool.filter((f) => f.audio === null);
	const chosen = any.length > 0 ? any : pool;
	return chosen.length > 0 ? Math.max(...chosen.map((f) => f.usd)) : null;
}

/** US dollars a second at `tier`, from a per-second price; null when the model has none. */
export function perSecondUsd(m: OpenRouterVideoModel, tier: string, audio: boolean): number | null {
	const found = Object.entries(m.skus).flatMap(([k, v]) => {
		const key = rateKey(k);
		return key ? [{ tier: key.tier, audio: key.audio, usd: key.cents ? v / 100 : v }] : [];
	});
	return pick(found, tier, audio);
}

/** US dollars a video token at `tier`, for a model priced by token (Seedance). */
function perTokenUsd(m: OpenRouterVideoModel, tier: string, audio: boolean): number | null {
	const found = Object.entries(m.skus).flatMap(([k, v]) => {
		const t = /^video_tokens(?:_(\d+p|\dk))?(_without_audio)?$/i.exec(k);
		return t ? [{ tier: t[1]?.toLowerCase() ?? null, audio: t[2] ? false : null, usd: v }] : [];
	});
	return pick(found, tier, audio);
}

/**
 * About what a clip of `seconds` at `width` × `height` costs, in US dollars;
 * null when the model is priced some way this can't tell. A model priced by
 * token is counted as ByteDance counts them, width × height × fps × seconds
 * ÷ 1024, at 24 fps.
 */
export function estimateUsd(
	m: OpenRouterVideoModel,
	seconds: number,
	width: number,
	height: number
): number | null {
	const tier = resolutionFor(m, width, height);
	const rate = perSecondUsd(m, tier, m.audio);
	if (rate !== null) return rate * seconds;
	const perToken = perTokenUsd(m, tier, m.audio);
	if (perToken === null) return null;
	return ((width * height * CAPS_FPS * seconds) / 1024) * perToken;
}
