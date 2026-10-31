/**
 * llama-toolchest's image HTTP shapes: what this backend sends and what it
 * reads back, apart from the calls so they test against recorded answers.
 *
 * Toolchest forwards an image request byte for byte to the sd-server instance
 * it picks, so the request is the one Lemonade's sd-cpp recipe takes: OpenAI
 * images, with sd-server's native fields in a `<sd_cpp_extra_args>` block at
 * the front of the prompt, and the same limit on how long that block may be
 * (`lemonade/adapter.ts` has the measurements). Ming's transparency fits; a
 * seam pass does not, so this backend does not tile either.
 *
 * Two routes draw: `/v1/images/jobs` (a job to poll, with a phase and a
 * place in the queue) on builds whose `meta.api` lists `images.jobs`, and the
 * blocking `/v1/images/generations` on older ones. An edit is the
 * `/v1/images/edits` form, on a set whose `meta.api` lists `images.edits`,
 * posted to `/v1/images/jobs` instead where it also lists `images.jobs.edits`:
 * sd-server takes each `image[]` as a reference picture and the optional
 * `mask` as where the change may go.
 */

import { CLEAR_START_STRENGTH } from '#lib/image/local/adapter.ts';
import { MAX_EXTRAS_CHARS, type SdExtras } from '#lib/image/lemonade/adapter.ts';
import type { ImageProgress } from '#lib/image/types.ts';

export const ROUTES = {
	models: '/v1/models',
	generate: '/v1/images/generations',
	edits: '/v1/images/edits',
	jobs: '/v1/images/jobs',
	/** Synchronous: toolchest hands it to an upscaler instance's `/sdcpp/v1/upscale`. */
	upscale: '/v1/images/upscale',
	job: (id: string) => `/v1/images/jobs/${encodeURIComponent(id)}`
} as const;

export interface ImageBody {
	model: string;
	prompt: string;
	size: string;
	n: 1;
	response_format: 'b64_json';
}

/**
 * The fields of an edit form: the generation body's, as plain text parts,
 * with the seed and sampler in the prompt's extras block as before.
 */
export function buildEditFields(req: Parameters<typeof buildImageBody>[0]): Record<string, string> {
	const body = buildImageBody(req);
	return {
		model: body.model,
		prompt: body.prompt,
		size: body.size,
		n: '1',
		response_format: body.response_format
	};
}

export function buildImageBody(req: {
	model: string;
	prompt: string;
	negativePrompt?: string;
	seed: number;
	width: number;
	height: number;
	/** Left out to keep the instance's own, which toolchest starts it with. */
	sampler?: { name: string; steps: number; cfg: number };
	/** A transparent PNG of the request's size, base64. */
	clearStart?: string;
}): ImageBody {
	const extras: Partial<SdExtras> = {
		seed: req.seed,
		width: req.width,
		height: req.height,
		...(req.negativePrompt?.trim() ? { negative_prompt: req.negativePrompt.trim() } : {})
	};
	if (req.sampler) {
		extras.sample_params = {
			sample_steps: req.sampler.steps,
			sample_method: req.sampler.name,
			guidance: { txt_cfg: req.sampler.cfg }
		};
	}
	if (req.clearStart) {
		extras.init_image = req.clearStart;
		extras.strength = CLEAR_START_STRENGTH;
	}
	const block = JSON.stringify(extras);
	if (block.length > MAX_EXTRAS_CHARS) {
		// Refused here rather than crashing the user's sd-server.
		throw new Error(
			`This request is too large for sd-server (${block.length} characters of parameters; ` +
				`it fails above about ${MAX_EXTRAS_CHARS}).`
		);
	}
	return {
		model: req.model,
		prompt: `<sd_cpp_extra_args>${block}</sd_cpp_extra_args> ${req.prompt}`,
		size: `${req.width}x${req.height}`,
		n: 1,
		response_format: 'b64_json'
	};
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** An image job as `GET /v1/images/jobs/{id}` (or the 202 that made it) has it. */
export interface ImageJob {
	id: string;
	status: JobStatus;
	/** `queued`, `generating`, `saving`; empty once it ends. */
	phase: string;
	/** Jobs ahead of it on its GPU. */
	ahead: number;
	/** Paths of the finished images, in order. */
	images: string[];
	error: string | null;
}

const STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];

export function readJob(v: unknown): ImageJob | null {
	const j = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
	if (typeof j.id !== 'string' || !j.id) return null;
	const status = STATUSES.includes(j.status as JobStatus) ? (j.status as JobStatus) : 'queued';
	const images = Array.isArray(j.images)
		? j.images
				.map((i) => (i as { url?: unknown })?.url)
				.filter((u): u is string => typeof u === 'string' && u.startsWith('/'))
		: [];
	return {
		id: j.id,
		status,
		phase: typeof j.phase === 'string' ? j.phase : '',
		ahead: typeof j.queue_position === 'number' ? j.queue_position : 0,
		images,
		error: typeof j.error === 'string' && j.error ? j.error : null
	};
}

/** What a job in flight is doing, as the shared progress line reads it. */
export function progressOf(job: ImageJob): ImageProgress {
	if (job.status === 'queued' || job.phase === 'queued') {
		return { phase: 'queued', ...(job.ahead > 0 ? { ahead: job.ahead } : {}) };
	}
	if (job.phase === 'saving') return { phase: 'downloading' };
	return { phase: 'running' };
}
