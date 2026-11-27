/**
 * OpenRouter's video models as a video backend: one per video model in
 * Settings → Video generation, paid for from the key its entry names.
 *
 * A clip is a job: `POST /v1/videos`, polled every few seconds
 * (`GET /v1/videos/{id}`) until it ends, then downloaded
 * (`/v1/videos/{id}/content`) and kept in the audio cache with its title.
 * The job's id is reported (`onHandle`) as soon as OpenRouter has it, so
 * `resume` can follow it after a restart.
 *
 * OpenRouter can't cancel a job. Cancelling the turn stops the wait, but the
 * clip is still made and paid for, so before anything is sent its cost is
 * estimated and a clip over the entry's limit (`options.maxClipUsd`, dollars;
 * 0 for none) is refused, which passes it to the next model.
 *
 * Start and end pictures go as data URLs. A model takes whole seconds from
 * a list, a resolution tier and an aspect ratio (`./adapter.ts`); the clip
 * that comes back is probed for its real size, length and sound.
 */

import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { fetchOpenRouterKeyStatus } from '#lib/openrouter.ts';
import {
	fetchWithin,
	jsonOf,
	openRouterHeaders,
	openRouterUrl,
	refusal,
	type MakeError
} from '#lib/openrouterCalls.ts';
import { formatUsd, mimeOf } from '#lib/image/openrouter/adapter.ts';
import type { ProbeResult } from '#lib/image/backend.ts';
import { toolchestKeyFor } from '#lib/toolchest/models.ts';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import { VideoBackendError, type VideoBackend } from '#lib/videogen/backend.ts';
import { registerVideoBackendKind } from '#lib/videogen/registry.ts';
import { videoEntryApiKey } from '#lib/videogen/entries.ts';
import { cachedClipInfo } from '#lib/videogen/clip.ts';
import { videoSrc } from '#lib/videogen/url.ts';
import type {
	VideoCaps,
	VideoGenerateOptions,
	VideoModelEntry,
	VideoRequest,
	VideoResult,
	VideoStartImage
} from '#lib/videogen/types.ts';
import {
	buildClipBody,
	capsOf,
	clipProgressOf,
	durationFor,
	ended,
	estimateUsd,
	makesClips,
	parseVideoModels,
	perSecondUsd,
	readClipJob,
	tierOf,
	tiers as capsTiers,
	videoModelOptions,
	type ClipJob,
	type OpenRouterVideoModel
} from '#lib/videogen/openrouter/adapter.ts';

/** The per-clip limit a new entry starts with, in US dollars. */
export const DEFAULT_MAX_CLIP_USD = 2;

/** The model list, a poll and a key check. */
const CALL_TIMEOUT_MS = 30_000;
/** Sending the job: its pictures go with it. */
const SUBMIT_TIMEOUT_MS = 120_000;
/** Downloading the finished clip. */
const DOWNLOAD_TIMEOUT_MS = 600_000;
/** How long a clip may take, queue included. */
const CLIP_DEADLINE_MS = 3_600_000;
/** How long the model list is kept before it is asked for again. */
const LIST_TTL_MS = 60 * 60 * 1000;
/** Some providers take a seed only below 2³¹. */
const SEED_LIMIT = 2 ** 31;

let pollMs = 10_000;
let listed: { at: number; models: Promise<OpenRouterVideoModel[]> } | null = null;

/** Test-only: forget the model list, and poll every `ms`. */
export function _resetForTests(ms = 0): void {
	listed = null;
	pollMs = ms;
}

const make: MakeError = (kind, message, opts) =>
	new VideoBackendError(kind, message, { status: opts?.status });

/** Said when a turn stops waiting: the job itself goes on. */
export const NOT_CANCELLED =
	"Stopped waiting. OpenRouter can't cancel a clip, so it may still be made and charged.";

async function getJson(path: string, apiKey?: string, signal?: AbortSignal): Promise<unknown> {
	return jsonOf(
		await fetchWithin(
			CALL_TIMEOUT_MS,
			openRouterUrl(path),
			{ headers: openRouterHeaders(apiKey) },
			make,
			signal
		),
		make,
		'clip'
	);
}

/** OpenRouter's video models, asked once an hour. */
export function videoModels(signal?: AbortSignal): Promise<OpenRouterVideoModel[]> {
	if (listed && Date.now() - listed.at < LIST_TTL_MS) return listed.models;
	const models = getJson('/v1/videos/models', undefined, signal).then(parseVideoModels);
	listed = { at: Date.now(), models };
	// A failed list is asked for again next time.
	void models.catch(() => {
		if (listed?.models === models) listed = null;
	});
	return models;
}

/** The tier `entry` makes clips at: its own choice, else 720p, else the smallest. */
export function entryTier(entry: VideoModelEntry, m: OpenRouterVideoModel): string {
	return tierOf(m, entry.options.resolution);
}

/** The per-clip limit in US dollars; 0 is none. */
export function maxClipUsd(entry: Pick<VideoModelEntry, 'options'>): number {
	const raw = entry.options.maxClipUsd;
	const n = raw === undefined || raw.trim() === '' ? DEFAULT_MAX_CLIP_USD : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_CLIP_USD;
}

/** `entry`'s model from the list, or why it can't make clips. */
async function chosenModel(
	entry: VideoModelEntry,
	signal?: AbortSignal
): Promise<OpenRouterVideoModel> {
	const id = entry.model.trim();
	if (!id) {
		throw new VideoBackendError(
			'unconfigured',
			'No OpenRouter video model is chosen — Settings → Video generation.'
		);
	}
	const model = (await videoModels(signal)).find((m) => m.id === id);
	if (!model || !makesClips(model)) {
		throw new VideoBackendError(
			'unconfigured',
			`OpenRouter no longer lists ${id} — Settings → Video generation.`
		);
	}
	return model;
}

async function keyOf(keyId: string | null): Promise<string> {
	const key = (await toolchestKeyFor(keyId)).trim();
	if (!key) {
		throw new VideoBackendError(
			'unconfigured',
			'No OpenRouter API key is chosen — Settings → Video generation.'
		);
	}
	return key;
}

/** A picture from the image cache as a data URL. */
async function dataUrlOf(image: VideoStartImage): Promise<string> {
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await invoke<ArrayBuffer>('image_read_bytes', { hash: image.hash }));
	} catch {
		throw new VideoBackendError('rejected', `${image.name} is no longer in the image cache.`);
	}
	return `data:${mimeOf(bytes)};base64,${bytesToBase64(bytes)}`;
}

/** Refuse what `m` can't do, or what would cost more than the limit, before anything is sent. */
function check(entry: VideoModelEntry, m: OpenRouterVideoModel, req: VideoRequest): void {
	if (req.audio) {
		throw new VideoBackendError(
			'unconfigured',
			`${m.name} on OpenRouter can't make someone speak.`
		);
	}
	if (req.startImage && !m.firstFrame) {
		throw new VideoBackendError(
			'unconfigured',
			`${m.name} on OpenRouter can't start from a picture.`
		);
	}
	if (req.endImage && !m.lastFrame) {
		throw new VideoBackendError('unconfigured', `${m.name} on OpenRouter can't end on a picture.`);
	}
	const limit = maxClipUsd(entry);
	if (limit === 0) return;
	const seconds = durationFor(m, req.frames, req.fps);
	const cost = estimateUsd(m, seconds, req.width, req.height);
	if (cost === null) {
		throw new VideoBackendError(
			'unconfigured',
			`Haruspex can't tell what a clip from ${m.name} costs, so the ${formatUsd(limit)} limit ` +
				"per clip in Settings → Video generation can't be checked. Set it to 0 to allow it."
		);
	}
	if (cost > limit) {
		throw new VideoBackendError(
			'unconfigured',
			`A clip of ${seconds} s from ${m.name} would cost about ${formatUsd(cost)}, over the ` +
				`${formatUsd(limit)} limit per clip in Settings → Video generation.`
		);
	}
}

/** Wait `ms`, or less when `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
	});
}

/** Poll job `id` until it ends; the job as it ended. */
async function follow(apiKey: string, id: string, opts: VideoGenerateOptions): Promise<ClipJob> {
	const deadline = Date.now() + CLIP_DEADLINE_MS;
	for (;;) {
		if (opts.signal?.aborted) throw new VideoBackendError('cancelled', NOT_CANCELLED);
		let job: ClipJob | null;
		try {
			job = readClipJob(await getJson(`/v1/videos/${encodeURIComponent(id)}`, apiKey, opts.signal));
		} catch (e) {
			if (e instanceof VideoBackendError && e.kind === 'cancelled') {
				throw new VideoBackendError('cancelled', NOT_CANCELLED);
			}
			throw e;
		}
		if (!job) throw new VideoBackendError('rejected', 'OpenRouter lost track of the clip.');
		if (ended(job)) return job;
		opts.onProgress?.(clipProgressOf(job));
		if (Date.now() > deadline) {
			throw new VideoBackendError('timeout', 'OpenRouter took over an hour to make the clip.');
		}
		await pause(pollMs, opts.signal);
	}
}

/** Download the finished clip into the audio cache. */
async function keep(
	apiKey: string,
	id: string,
	req: VideoRequest,
	opts: VideoGenerateOptions
): Promise<StoredAudio> {
	const res = await fetchWithin(
		DOWNLOAD_TIMEOUT_MS,
		openRouterUrl(`/v1/videos/${encodeURIComponent(id)}/content?index=0`),
		{ headers: openRouterHeaders(apiKey) },
		make,
		opts.signal
	);
	if (!res.ok) throw await refusal(res, make, 'clip');
	const bytes = new Uint8Array(await res.arrayBuffer());
	const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
	const mime = type === 'video/webm' ? 'video/webm' : 'video/mp4';
	try {
		return await invoke<StoredAudio>('audio_store_bytes', bytes, {
			headers: {
				'x-mime': mime,
				...(req.title.trim() ? { 'x-title': encodeURIComponent(req.title.trim()) } : {}),
				...(opts.conversationId ? { 'x-conversation-id': opts.conversationId } : {}),
				...(opts.codeSessionId ? { 'x-code-session-id': opts.codeSessionId } : {})
			}
		});
	} catch (e) {
		throw new VideoBackendError('rejected', `The clip could not be kept: ${errMessage(e)}`);
	}
}

/** Follow job `id` to its end and keep the clip. */
async function finish(
	apiKey: string,
	id: string,
	model: string,
	req: VideoRequest,
	opts: VideoGenerateOptions
): Promise<VideoResult> {
	const job = await follow(apiKey, id, opts);
	if (job.status !== 'completed') {
		const why = job.error ?? `the job was ${job.status}`;
		throw new VideoBackendError('rejected', `OpenRouter made no clip: ${why}.`);
	}
	if (job.cost !== null) logDebug('video', `openrouter: ${model} cost ${formatUsd(job.cost)}`);
	opts.onProgress?.({ phase: 'saving' });
	const stored = await keep(apiKey, id, req, opts);
	return {
		hash: stored.hash,
		url: videoSrc(stored.hash) ?? '',
		mime: stored.mime,
		...(await whatWasMade(stored.hash, req)),
		seed: req.seed,
		model
	};
}

/**
 * The clip's real size, length and sound, as ffprobe reads it: a model makes
 * its own lengths and sizes. What was asked for when it can't be probed.
 */
async function whatWasMade(
	hash: string,
	req: VideoRequest
): Promise<Pick<VideoResult, 'width' | 'height' | 'frames' | 'fps' | 'hasAudio'>> {
	const info = await cachedClipInfo(hash);
	const v = info?.video;
	if (!info || !v) {
		return {
			width: req.width,
			height: req.height,
			frames: req.frames,
			fps: req.fps,
			hasAudio: false
		};
	}
	const fps = v.fpsDen > 0 ? v.fpsNum / v.fpsDen : req.fps;
	return {
		width: v.width || req.width,
		height: v.height || req.height,
		frames: info.durationSecs > 0 ? Math.round(info.durationSecs * fps) : req.frames,
		fps: Math.round(fps * 100) / 100,
		hasAudio: info.audio.length > 0
	};
}

/** Send one clip and follow it to its end. */
async function generateWith(
	entry: VideoModelEntry,
	req: VideoRequest,
	opts: VideoGenerateOptions
): Promise<VideoResult> {
	const m = await chosenModel(entry, opts.signal);
	check(entry, m, req);
	const apiKey = await keyOf(entry.keyId);
	const body = buildClipBody(m, {
		prompt: req.prompt,
		width: req.width,
		height: req.height,
		frames: req.frames,
		fps: req.fps,
		seed: req.seed % SEED_LIMIT,
		startUrl: req.startImage ? await dataUrlOf(req.startImage) : undefined,
		endUrl: req.endImage ? await dataUrlOf(req.endImage) : undefined
	});
	opts.onProgress?.({ phase: 'starting' });
	const created = readClipJob(
		await jsonOf(
			await fetchWithin(
				SUBMIT_TIMEOUT_MS,
				openRouterUrl('/v1/videos'),
				{ method: 'POST', headers: openRouterHeaders(apiKey, true), body: JSON.stringify(body) },
				make,
				opts.signal
			),
			make,
			'clip'
		)
	);
	if (!created) throw new VideoBackendError('rejected', 'OpenRouter made no job.');
	opts.onHandle?.({
		backend: 'openrouter',
		baseUrl: openRouterUrl(''),
		id: created.id,
		model: m.id,
		keyId: entry.keyId ?? ''
	});
	return finish(apiKey, created.id, entry.name, req, opts);
}

/** A few words on what `m` costs at `tier`: "about $0.10 a second at 720p, with sound". */
export function priceWords(m: OpenRouterVideoModel, tier: string): string | null {
	const rate = perSecondUsd(m, tier, m.audio);
	const sound = m.audio ? ', with sound' : '';
	if (rate !== null) return `${formatUsd(rate)} a second at ${tier}${sound}`;
	const five = estimateUsd(m, 5, ...sizeAt(m, tier));
	return five !== null ? `about ${formatUsd(five)} for 5 s at ${tier}${sound}` : null;
}

function sizeAt(m: OpenRouterVideoModel, tier: string): [number, number] {
	const [w, h] = capsOf(m, tier).limits.defaultSize.split('x').map(Number);
	return [w, h];
}

async function probeEntry(entry: VideoModelEntry, signal?: AbortSignal): Promise<ProbeResult> {
	let models: OpenRouterVideoModel[];
	try {
		models = await videoModels(signal);
	} catch (e) {
		return { ok: false, detail: errMessage(e) };
	}
	const options = videoModelOptions(models);
	const key = (await videoEntryApiKey(entry)).trim();
	if (!key) return { ok: false, detail: 'Choose an OpenRouter API key.', models: options };
	try {
		await fetchOpenRouterKeyStatus(key, signal);
	} catch (e) {
		return { ok: false, detail: errMessage(e), models: options };
	}
	const id = entry.model.trim();
	if (!id) return { ok: false, detail: 'Choose a model.', models: options };
	const m = models.find((x) => x.id === id);
	if (!m || !makesClips(m)) {
		return { ok: false, detail: `OpenRouter no longer lists ${id}.`, models: options };
	}
	const price = priceWords(m, entryTier(entry, m));
	return { ok: true, detail: price ? `Connected — ${price}.` : 'Connected.', models: options };
}

/** The backend for one OpenRouter video model. */
export function openRouterVideoFor(entry: VideoModelEntry): VideoBackend {
	return {
		kind: 'openrouter',
		probe: (signal) => probeEntry(entry, signal),
		async capabilities(signal): Promise<VideoCaps> {
			const m = await chosenModel(entry, signal);
			return capsOf(m, entryTier(entry, m));
		},
		models: async (signal) => videoModelOptions(await videoModels(signal)),
		generate: (req, opts = {}) => generateWith(entry, req, opts),
		resume: async (handle, req, opts = {}) => {
			const apiKey = await keyOf(handle.keyId || null);
			const name =
				handle.entryId === entry.id && handle.model === entry.model ? entry.name : handle.model;
			return finish(apiKey, handle.id, name, req, opts);
		}
	};
}

registerVideoBackendKind('openrouter', openRouterVideoFor);

/** The resolution tiers model `id` makes, smallest first; none when it isn't listed. */
export async function modelTiers(id: string): Promise<string[]> {
	const m = (await videoModels().catch(() => [])).find((x) => x.id === id);
	return m ? capsTiers(m) : [];
}
