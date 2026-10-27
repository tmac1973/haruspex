/**
 * A llama-toolchest server's video instances (Wan 2.2 and the like), set up in
 * Settings → Video generation.
 *
 * A clip is a job on toolchest's queue (`/v1/videos/jobs`): polled once a
 * second for its phase and step (`followJob`), then downloaded straight into
 * the audio cache by Rust (`audio_store_url`) and deleted from the server.
 * Cancelling sends `DELETE`. The job's id is reported (`onHandle`) as soon as
 * it is queued, so `resumeVideo` can follow it again after a restart.
 *
 * A starting picture goes as a file part from the image cache, so it never
 * crosses the bridge.
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '#lib/stores/settings.ts';
import {
	parseGenerationModels,
	toolchestKeyFor,
	type ToolchestInstance
} from '#lib/toolchest/models.ts';
import {
	ToolchestError,
	hostOf,
	toolchestJson,
	toolchestUpload,
	type ToolchestConfig
} from '#lib/toolchest/client.ts';
import { followJob, removeJob, type JobLike } from '#lib/toolchest/jobs.ts';
import { videoSrc } from '#lib/videogen/url.ts';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import type { ProbeResult } from '#lib/image/backend.ts';
import type {
	VideoGenerateOptions,
	VideoJobHandle,
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
		frames: req.frames,
		fps: req.fps,
		seed: req.seed,
		output_format: 'webm'
	};
	if (req.negativePrompt?.trim()) body.negative_prompt = req.negativePrompt.trim();
	return body;
}

/** What the last probe saw, for Settings' table. */
let lastInstances: ToolchestInstance[] = [];

export function seenVideoInstances(): ToolchestInstance[] {
	return lastInstances;
}

async function config(): Promise<ToolchestConfig> {
	const s = getSettings();
	return {
		baseUrl: s.videoGenToolchestBaseUrl.trim(),
		apiKey: await toolchestKeyFor(s.videoGenToolchestApiKeyId)
	};
}

async function videoInstances(cfg: ToolchestConfig, signal?: AbortSignal) {
	lastInstances = parseGenerationModels(
		await toolchestJson(cfg, { path: ROUTES.models }, signal),
		'video'
	);
	return lastInstances;
}

/** The chosen instance, running, or why it can't make a clip now. */
export async function readyVideoInstance(signal?: AbortSignal): Promise<ToolchestInstance> {
	const cfg = await config();
	if (!cfg.baseUrl) {
		throw new Error('No llama-toolchest server is set — Settings → Video generation.');
	}
	const id = (getSettings().videoGenToolchestModelId ?? '').trim();
	if (!id) throw new Error('No video model is chosen — Settings → Video generation.');
	const instance = (await videoInstances(cfg, signal)).find((i) => i.id === id);
	if (!instance) {
		throw new Error(
			`${id} is not on ${hostOf(cfg.baseUrl)} any more — Settings → Video generation.`
		);
	}
	if (instance.state !== 'running') {
		throw new Error(`${id} is ${instance.state} — start it in llama-toolchest.`);
	}
	return instance;
}

/** Follow a job to its end and keep the clip. */
async function finish(
	cfg: ToolchestConfig,
	created: VideoJob,
	model: string,
	req: VideoRequest,
	opts: VideoGenerateOptions
): Promise<VideoResult> {
	const job = await followJob(cfg, created, ROUTES.job, readVideoJob, {
		signal: opts.signal,
		onJob: (j) => opts.onProgress?.(videoProgressOf(j))
	});
	if (job.status === 'cancelled') throw new ToolchestError('cancelled', 'Cancelled.');
	if (job.status === 'failed') {
		throw new ToolchestError('rejected', `llama-toolchest: ${job.error ?? 'the job failed'}`);
	}
	if (!job.videoUrl) throw new ToolchestError('rejected', 'llama-toolchest gave no video.');
	opts.onProgress?.({ phase: 'saving' });
	const stored = await invoke<StoredAudio>('audio_store_url', {
		url: `${cfg.baseUrl.replace(/\/+$/, '')}${job.videoUrl}`,
		apiKey: cfg.apiKey || null,
		mimeHint: job.mime,
		title: req.title || null,
		conversationId: opts.conversationId ?? null,
		codeSessionId: opts.codeSessionId ?? null
	});
	removeJob(cfg, ROUTES.job(job.id));
	return {
		hash: stored.hash,
		url: videoSrc(stored.hash) ?? '',
		mime: stored.mime,
		width: job.width || req.width,
		height: job.height || req.height,
		frames: job.frames || req.frames,
		fps: job.fps || req.fps,
		seed: req.seed,
		model
	};
}

/** Make the clip on the instance in Settings → Video generation. */
export async function generateVideo(
	req: VideoRequest,
	opts: VideoGenerateOptions = {}
): Promise<VideoResult> {
	const cfg = await config();
	const instance = await readyVideoInstance(opts.signal);
	const body = buildVideoBody(req, instance.id);
	const created = readVideoJob(
		req.startImage
			? await toolchestUpload(
					cfg,
					{ path: ROUTES.jobs, body },
					[
						{
							field: 'start_image',
							filename: req.startImage.name,
							hash: req.startImage.hash,
							cache: 'image',
							bytes: null
						}
					],
					opts.signal,
					true
				)
			: await toolchestJson(cfg, { method: 'POST', path: ROUTES.jobs, body }, opts.signal)
	);
	if (!created) throw new ToolchestError('rejected', 'llama-toolchest made no job.');
	opts.onHandle?.({
		backend: 'llama-toolchest',
		baseUrl: cfg.baseUrl,
		id: created.id,
		model: instance.id,
		keyId: getSettings().videoGenToolchestApiKeyId ?? ''
	});
	return finish(cfg, created, instance.id, req, opts);
}

/** Follow a job an earlier run sent, on the server it went to, whatever the settings say now. */
export async function resumeVideo(
	handle: VideoJobHandle,
	req: VideoRequest,
	opts: VideoGenerateOptions = {}
): Promise<VideoResult> {
	const cfg: ToolchestConfig = {
		baseUrl: handle.baseUrl,
		apiKey: await toolchestKeyFor(handle.keyId || null)
	};
	return finish(cfg, readVideoJob({ id: handle.id })!, handle.model, req, opts);
}

/** Settings → Video generation's Probe: reachable, and the chosen instance running. */
export async function probeVideo(): Promise<ProbeResult> {
	const cfg = await config();
	if (!cfg.baseUrl)
		return { ok: false, detail: 'No server address — Settings → Video generation.' };
	const host = hostOf(cfg.baseUrl);
	let instances: ToolchestInstance[];
	try {
		instances = await videoInstances(cfg);
	} catch (e) {
		if (e instanceof ToolchestError && e.status === 401) {
			return { ok: false, detail: 'Wrong or missing API key.' };
		}
		if (e instanceof ToolchestError && e.kind === 'unreachable') {
			return { ok: false, detail: `Can't reach ${host}.` };
		}
		return { ok: false, detail: e instanceof Error ? e.message : String(e) };
	}
	const models = instances.map((i) => ({
		name: i.id,
		label: i.state === 'running' ? i.id : `${i.id} — ${i.state}`
	}));
	if (instances.length === 0) {
		return {
			ok: false,
			detail: `${host} has no video models. Add one in llama-toolchest.`,
			models
		};
	}
	const chosen = instances.find((i) => i.id === getSettings().videoGenToolchestModelId);
	if (!chosen)
		return { ok: false, detail: 'No model is chosen — Settings → Video generation.', models };
	if (chosen.state !== 'running') {
		return {
			ok: false,
			detail: `${chosen.id} is ${chosen.state} — start it in llama-toolchest.`,
			models
		};
	}
	return { ok: true, detail: `Connected — ${chosen.id} on ${host}.`, models };
}
