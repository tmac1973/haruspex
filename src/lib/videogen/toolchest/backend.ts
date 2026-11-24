/**
 * A llama-toolchest server's video instances (Wan 2.2, LTX-2.3 and the like):
 * one backend per video model in Settings → Video generation.
 *
 * A clip is a job on toolchest's queue (`/v1/videos/jobs`): polled once a
 * second for its phase and step (`followJob`), then downloaded straight into
 * the audio cache by Rust (`audio_store_url`) and deleted from the server.
 * Cancelling sends `DELETE`. The job's id is reported (`onHandle`) as soon as
 * it is queued, so `resume` can follow it again after a restart.
 *
 * A starting or ending picture goes as a file part from the image cache, so
 * it never crosses the bridge. A finished clip is probed for a sound track,
 * since toolchest's meta doesn't say which sets make one.
 */

import type { ToolchestInstance } from '#lib/toolchest/models.ts';
import {
	ToolchestError,
	toolchestJson,
	toolchestUpload,
	type ToolchestConfig
} from '#lib/toolchest/client.ts';
import { followJob, removeJob, type JobLike } from '#lib/toolchest/jobs.ts';
import {
	instanceLabel,
	settleJob,
	storeJobFile,
	toolchestServer,
	usable
} from '#lib/toolchest/kind.ts';
import { entryConfigKey } from '#lib/generation/entry.ts';
import { videoSrc } from '#lib/videogen/url.ts';
import { clipHasAudio } from '#lib/videogen/clip.ts';
import { capsFromInstance } from '#lib/videogen/capsOf.ts';
import { VideoBackendError, type VideoBackend } from '#lib/videogen/backend.ts';
import { registerVideoBackendKind } from '#lib/videogen/registry.ts';
import type {
	VideoGenerateOptions,
	VideoModelEntry,
	VideoProgress,
	VideoRequest,
	VideoResult
} from '#lib/videogen/types.ts';

export const ROUTES = {
	models: '/v1/models',
	jobs: '/v1/videos/jobs',
	job: (id: string) => `/v1/videos/jobs/${encodeURIComponent(id)}`
} as const;

/** A video job, as Haruspex reads it. */
export interface VideoJob extends JobLike {
	phase: string;
	ahead: number;
	step: number;
	totalSteps: number;
	model: string;
	/** Where the finished file is, on the server: `/v1/videos/jobs/<id>/video`. */
	videoUrl: string | null;
	mime: string;
	width: number;
	height: number;
	frames: number;
	fps: number;
	error: string | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const STATUSES: JobLike['status'][] = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];

export function readVideoJob(v: unknown): VideoJob | null {
	const j = obj(v);
	if (typeof j.id !== 'string' || !j.id) return null;
	const progress = obj(j.progress);
	const video = obj(j.video);
	const url = text(video.url);
	const error = obj(j.error);
	return {
		id: j.id,
		status: STATUSES.includes(j.status as JobLike['status'])
			? (j.status as JobLike['status'])
			: 'queued',
		phase: text(j.phase),
		ahead: int(j.queue_position),
		step: int(progress.step),
		totalSteps: int(progress.total_steps),
		model: text(j.model),
		videoUrl: url.startsWith('/') ? url : null,
		mime: text(video.mime_type) || 'video/webm',
		width: int(video.width),
		height: int(video.height),
		frames: int(video.frames),
		fps: int(video.fps),
		error: text(j.error) || text(error.message) || null
	};
}

export function videoProgressOf(job: VideoJob): VideoProgress {
	if (job.status === 'queued' || job.phase === 'queued') {
		return { phase: 'queued', ...(job.ahead > 0 ? { ahead: job.ahead } : {}) };
	}
	if (job.phase === 'starting') return { phase: 'starting' };
	if (job.phase === 'saving') return { phase: 'saving' };
	return {
		phase: 'generating',
		...(job.totalSteps > 0 ? { step: job.step, totalSteps: job.totalSteps } : {})
	};
}

/** The job request: JSON, or a form's text fields when a picture goes with it. */
export function buildVideoBody(req: VideoRequest, model: string): Json {
	const body: Json = {
		model,
		prompt: req.prompt.trim(),
		size: `${req.width}x${req.height}`,
		fps: req.fps,
		seed: req.seed,
		output_format: 'webm'
	};
	// With speech and no length asked for, the server follows the speech.
	if (!(req.audio && req.followAudio)) body.frames = req.frames;
	if (req.negativePrompt?.trim()) body.negative_prompt = req.negativePrompt.trim();
	return body;
}

/** The pictures (from the image cache) and speech (from the audio cache) a request sends as form parts. */
export function videoFiles(req: VideoRequest) {
	const files = [];
	for (const [field, image] of [
		['start_image', req.startImage],
		['end_image', req.endImage]
	] as const) {
		if (image) {
			files.push({
				field,
				filename: image.name,
				hash: image.hash,
				cache: 'image' as const,
				bytes: null
			});
		}
	}
	if (req.audio) {
		files.push({
			field: 'audio',
			filename: req.audio.name,
			hash: req.audio.hash,
			cache: 'audio' as const,
			bytes: null
		});
	}
	return files;
}

/** Follow a job to its end and keep the clip; `model` is what the answer names. */
async function finish(
	cfg: ToolchestConfig,
	created: VideoJob,
	model: string,
	req: VideoRequest,
	opts: VideoGenerateOptions
): Promise<VideoResult> {
	const job = settleJob(
		await followJob(cfg, created, ROUTES.job, readVideoJob, {
			signal: opts.signal,
			onJob: (j) => opts.onProgress?.(videoProgressOf(j))
		})
	);
	if (!job.videoUrl) throw new ToolchestError('rejected', 'llama-toolchest gave no video.');
	opts.onProgress?.({ phase: 'saving' });
	const stored = await storeJobFile(cfg, job.videoUrl, job.mime, {
		title: req.title,
		conversationId: opts.conversationId,
		codeSessionId: opts.codeSessionId
	});
	removeJob(cfg, ROUTES.job(job.id));
	const hasAudio = await clipHasAudio(stored.hash);
	return {
		hash: stored.hash,
		url: videoSrc(stored.hash) ?? '',
		mime: stored.mime,
		width: job.width || req.width,
		height: job.height || req.height,
		frames: job.frames || req.frames,
		fps: job.fps || req.fps,
		seed: req.seed,
		model,
		hasAudio
	};
}

type Server = ReturnType<typeof toolchestServer>;

/** Each entry's view of its server, kept while the entry's config is unchanged. */
const servers = new Map<string, { key: string; server: Server }>();

function serverFor(entry: VideoModelEntry): Server {
	const key = entryConfigKey(entry);
	const have = servers.get(entry.id);
	if (have?.key === key) return have.server;
	const server = toolchestServer('video', () => ({
		baseUrl: entry.url,
		keyId: entry.keyId,
		modelId: entry.model
	}));
	servers.set(entry.id, { key, server });
	return server;
}

/** Toolchest's error as a video backend's, so routing knows which ones to pass over. */
function asVideoError(e: unknown): unknown {
	if (!(e instanceof ToolchestError)) return e;
	return new VideoBackendError(e.kind, e.message, { status: e.status });
}

async function mapped<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		throw asVideoError(e);
	}
}

/** The backend for one toolchest video model. */
export function toolchestVideoFor(entry: VideoModelEntry): VideoBackend {
	const server = serverFor(entry);

	async function ready(signal?: AbortSignal): Promise<ToolchestInstance> {
		const instance = await server.readyInstance(await server.config(), signal);
		if (!instance.video) {
			throw new ToolchestError('unconfigured', `${instance.id} is not a video model.`);
		}
		return instance;
	}

	return {
		kind: 'llama-toolchest',
		probe: () => mapped(() => server.probe()),
		capabilities: (signal) =>
			mapped(
				async () =>
					capsFromInstance(await ready(signal)) as NonNullable<ReturnType<typeof capsFromInstance>>
			),
		models: (signal) =>
			mapped(async () =>
				(await server.instances(await server.config(), signal))
					.filter(usable)
					.map((i) => ({ name: i.id, label: instanceLabel(i) }))
			),
		generate: (req, opts = {}) =>
			mapped(async () => {
				const cfg = await server.config();
				const instance = await ready(opts.signal);
				const body = buildVideoBody(req, instance.id);
				const files = videoFiles(req);
				if (req.audio && !instance.capabilities.includes('audio')) {
					throw new ToolchestError('unconfigured', `${instance.id} can't make someone speak.`);
				}
				const created = readVideoJob(
					files.length > 0
						? await toolchestUpload(cfg, { path: ROUTES.jobs, body }, files, opts.signal, true)
						: await toolchestJson(cfg, { method: 'POST', path: ROUTES.jobs, body }, opts.signal)
				);
				if (!created) throw new ToolchestError('rejected', 'llama-toolchest made no job.');
				opts.onHandle?.({
					backend: 'llama-toolchest',
					baseUrl: cfg.baseUrl,
					id: created.id,
					model: instance.id,
					keyId: server.keyId()
				});
				return finish(cfg, created, entry.name, req, opts);
			}),
		resume: (handle, req, opts = {}) =>
			mapped(async () => {
				const cfg = await server.configFor(handle.baseUrl, handle.keyId);
				const name =
					handle.entryId === entry.id && handle.model === entry.model ? entry.name : handle.model;
				return finish(cfg, readVideoJob({ id: handle.id })!, name, req, opts);
			})
	};
}

registerVideoBackendKind('llama-toolchest', toolchestVideoFor);

/** The video instances on `entry`'s server, as its last probe or generation saw them. */
export function seenToolchestVideoInstances(entry: VideoModelEntry): ToolchestInstance[] {
	return serverFor(entry).seen();
}
