/**
 * llama-toolchest's music job shapes (`internal/api/gen_music.go`): the body
 * of `POST /v1/music/jobs`, the job it answers with, and how that job's phase
 * reads as progress. Kept apart from the calls so they test against answers
 * of the shape toolchest gives.
 */

import type { JobLike } from '#lib/toolchest/jobs.ts';
import type { MusicProgress, MusicRequest } from '#lib/music/types.ts';
import { onSource, taskFields } from '#lib/music/tasks.ts';

export const ROUTES = {
	models: '/v1/models',
	jobs: '/v1/music/jobs',
	job: (id: string) => `/v1/music/jobs/${encodeURIComponent(id)}`
} as const;

/** What ACE-Step reads as "no vocals". */
export const INSTRUMENTAL = '[Instrumental]';

/**
 * The job request. Zero and empty values are left out, so ACE picks its own.
 * A task on a song takes its length from the song, so none is sent.
 */
export function buildJobBody(req: MusicRequest, model: string): Record<string, unknown> {
	const lyrics = req.lyrics?.trim() || (req.instrumental ? INSTRUMENTAL : '');
	const body: Record<string, unknown> = {
		model,
		caption: req.caption.trim(),
		seed: req.seed,
		output_format: req.format,
		// ACE's model may rewrite the caption first; off, as toolchest has it,
		// because it turned a male vocal into a female one in testing.
		rewrite_caption: false,
		...taskFields(req)
	};
	if (!onSource(req)) body.duration = req.durationSec;
	if (lyrics) body.lyrics = lyrics;
	if (req.bpm) body.bpm = req.bpm;
	if (req.key?.trim()) body.keyscale = req.key.trim();
	if (req.timeSignature?.trim()) body.timesignature = req.timeSignature.trim();
	if (req.language?.trim()) body.vocal_language = req.language.trim();
	return body;
}

/** A music job, as toolchest has it. */
export interface MusicJob extends JobLike {
	/** `queued`, `composing`, `synthesizing`, `saving`; empty once it ends. */
	phase: string;
	ahead: number;
	model: string;
	/** Path of the finished file, relative to the server. */
	audioUrl: string | null;
	/** What ACE settled on, once composing is done. */
	result: { bpm?: number; duration?: number; keyscale?: string; seed?: number };
	error: string | null;
}

const STATUSES: JobLike['status'][] = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];

type Json = Record<string, unknown>;
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const text = (x: unknown) => (typeof x === 'string' && x ? x : undefined);

/** What ACE settled on, from a job's `result`. */
function readResult(v: unknown): MusicJob['result'] {
	const r = (v && typeof v === 'object' ? v : {}) as Json;
	return {
		bpm: num(r.bpm),
		duration: num(r.duration),
		keyscale: text(r.keyscale),
		seed: num(r.seed)
	};
}

export function readMusicJob(v: unknown): MusicJob | null {
	const j = (v && typeof v === 'object' ? v : {}) as Json;
	if (typeof j.id !== 'string' || !j.id) return null;
	const audio = text(j.audio_url)?.startsWith('/') ? (j.audio_url as string) : null;
	return {
		id: j.id,
		status: STATUSES.includes(j.status as JobLike['status'])
			? (j.status as JobLike['status'])
			: 'queued',
		phase: text(j.phase) ?? '',
		ahead: typeof j.queue_position === 'number' ? j.queue_position : 0,
		model: text(j.model) ?? '',
		audioUrl: audio,
		result: readResult(j.result),
		error: text(j.error) ?? null
	};
}

const PHASES: Record<string, MusicProgress['phase']> = {
	queued: 'queued',
	composing: 'composing',
	synthesizing: 'synthesizing',
	saving: 'saving'
};

/** What a job in flight is doing. A build from before phases says only running. */
export function musicProgressOf(job: MusicJob): MusicProgress {
	if (job.status === 'queued' || job.phase === 'queued') {
		return { phase: 'queued', ...(job.ahead > 0 ? { ahead: job.ahead } : {}) };
	}
	return { phase: PHASES[job.phase] ?? 'running' };
}

/** The type of the file a job writes, for the cache when the server doesn't say. */
export function mimeFor(format: 'mp3' | 'wav'): string {
	return format === 'wav' ? 'audio/wav' : 'audio/mpeg';
}
