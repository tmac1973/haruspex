/**
 * acestep.cpp's ace-server shapes: `/props`, the bodies of `POST /lm` and
 * `POST /synth`, and the job answers polled between them. Kept apart from the
 * calls so they test against answers of the shape ace-server gives.
 */

import { INSTRUMENTAL } from '#lib/music/toolchest/adapter.ts';
import { MUSIC_TASKS, type MusicRequest, type MusicTask } from '#lib/music/types.ts';
import { taskFields } from '#lib/music/tasks.ts';

export const ROUTES = {
	props: '/props',
	lm: '/lm',
	synth: '/synth',
	job: (id: string) => `/job?id=${encodeURIComponent(id)}`,
	result: (id: string) => `/job?id=${encodeURIComponent(id)}&result=1`,
	cancel: (id: string) => `/job?id=${encodeURIComponent(id)}&cancel=1`
} as const;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
	(v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Json;
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const text = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
const names = (x: unknown) => (Array.isArray(x) ? x.filter((n) => typeof n === 'string' && n) : []);

/** What `/props` says about the server. */
export interface AceProps {
	version: string;
	/** The DiT (synthesis) models it loaded; a request may name one. */
	synthModels: string[];
	/** The composing LM it loaded; none means it can't compose. */
	lmModels: string[];
}

export function readProps(v: unknown): AceProps | null {
	const p = obj(v);
	if (!p.models || typeof p.models !== 'object') return null;
	const models = obj(p.models);
	return {
		version: text(p.version) ?? '',
		synthModels: names(models.dit),
		lmModels: names(models.lm)
	};
}

/**
 * The compose request. Zero and empty values are left out, so ACE picks its
 * own. The caption is not rewritten: `use_cot_caption` is on by default, and
 * it turned a male vocal into a female one when toolchest tried it.
 */
export function buildLmBody(req: MusicRequest): Json {
	const lyrics = req.lyrics?.trim() || (req.instrumental ? INSTRUMENTAL : '');
	const body: Json = {
		caption: req.caption.trim(),
		duration: req.durationSec,
		seed: req.seed,
		lm_seed: req.seed,
		use_cot_caption: false
	};
	if (lyrics) body.lyrics = lyrics;
	if (req.bpm) body.bpm = req.bpm;
	if (req.key?.trim()) body.keyscale = req.key.trim();
	if (req.timeSignature?.trim()) body.timesignature = req.timeSignature.trim();
	if (req.language?.trim()) body.vocal_language = req.language.trim();
	return body;
}

/** What composing settled on: the request `/synth` takes, audio codes and all. */
export function readComposed(v: unknown): Json | null {
	const first = Array.isArray(v) ? v[0] : v;
	const r = obj(first);
	return typeof r.caption === 'string' ? r : null;
}

/** The synth request: the composed one, in the format asked, on the model chosen. */
export function buildSynthBody(
	composed: Json,
	format: MusicRequest['format'],
	model: string
): Json {
	const body: Json = { ...composed, output_format: format === 'wav' ? 'wav16' : 'mp3' };
	if (model) body.synth_model = model;
	return body;
}

/**
 * The synth request for a task on a song, which skips composing: the song
 * stands in for the arrangement `/lm` would write, as the official server
 * has it. Its length comes from the song.
 */
export function buildEditSynthBody(req: MusicRequest, model: string): Json {
	const lyrics = req.lyrics?.trim() || (req.instrumental ? INSTRUMENTAL : '');
	const body: Json = {
		caption: req.caption.trim(),
		seed: req.seed,
		output_format: req.format === 'wav' ? 'wav16' : 'mp3',
		...taskFields(req)
	};
	if (lyrics) body.lyrics = lyrics;
	if (req.bpm) body.bpm = req.bpm;
	if (req.key?.trim()) body.keyscale = req.key.trim();
	if (req.language?.trim()) body.vocal_language = req.language.trim();
	if (model) body.synth_model = model;
	return body;
}

/**
 * The tasks a synthesis model runs. acestep.cpp warns that a turbo model's
 * stem tasks come out incoherent; it tells turbo apart by the model's
 * metadata, and every ACE-Step GGUF we know of says so in its name.
 */
export function tasksFor(model: string): MusicTask[] {
	if (!/turbo/i.test(model)) return MUSIC_TASKS;
	return MUSIC_TASKS.filter((t) => t !== 'lego' && t !== 'extract' && t !== 'complete');
}

/** The tempo, key, length and seed a composed request holds. */
export function composedFacts(composed: Json) {
	return {
		bpm: num(composed.bpm),
		duration: num(composed.duration),
		keyscale: text(composed.keyscale),
		seed: num(composed.seed)
	};
}

export function readJobId(v: unknown): string | null {
	return text(obj(v).id) ?? null;
}

export type AceStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** A job's status; anything not yet ended reads as running. */
export function readStatus(v: unknown): AceStatus {
	const s = obj(v).status;
	return s === 'done' || s === 'failed' || s === 'cancelled' ? s : 'running';
}

/** ace-server's `{"error": "..."}`, when a refusal has one. */
export function errorOf(body: string): string | null {
	try {
		return text(obj(JSON.parse(body)).error) ?? null;
	} catch {
		return null;
	}
}
