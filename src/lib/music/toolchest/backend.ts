/**
 * A llama-toolchest server's ACE-Step instances as the music backend.
 *
 * A song is a job on toolchest's queue (`/v1/music/jobs`): polled once a
 * second for its phase, then downloaded straight into the audio cache by
 * Rust (`audio_store_url`), because toolchest forgets it after a day, and
 * then deleted from the server. Cancelling the turn sends `DELETE`, which
 * ace-server honours mid-song. The job's id is reported (`onHandle`), so
 * `resume` can follow it again after a restart.
 * Instances are started in toolchest; a stopped one is a sentence here.
 */

import { registerMusicBackend } from '#lib/music/registry.ts';
import type { MusicBackend, ProbeResult } from '#lib/music/backend.ts';
import {
	MusicBackendError,
	type MusicGenerateOptions,
	type MusicJobHandle,
	type MusicRequest,
	type MusicResult,
	type MusicTask
} from '#lib/music/types.ts';
import { knownTasks, uploadsOf } from '#lib/music/tasks.ts';
import {
	ToolchestError,
	toolchestJson,
	toolchestUpload,
	type ToolchestConfig
} from '#lib/toolchest/client.ts';
import { followJob, removeJob } from '#lib/toolchest/jobs.ts';
import { settleJob, storeJobFile, toolchestKind } from '#lib/toolchest/kind.ts';
import { audioSrc } from '#lib/audio/url.ts';
import {
	ROUTES,
	buildJobBody,
	mimeFor,
	musicProgressOf,
	readMusicJob,
	type MusicJob
} from '#lib/music/toolchest/adapter.ts';

const server = toolchestKind('music');

/** Every music instance the last probe saw. */
export const seenMusicInstances = server.seen;

function asMusicError(e: unknown): unknown {
	if (!(e instanceof ToolchestError)) return e;
	if (e.kind === 'cancelled') return new MusicBackendError('cancelled', 'Cancelled.');
	return new MusicBackendError(e.kind, e.message, { status: e.status });
}

async function run(
	cfg: ToolchestConfig,
	req: MusicRequest,
	opts: MusicGenerateOptions
): Promise<MusicResult> {
	const instance = await server.readyInstance(cfg, opts.signal);
	const body = buildJobBody(req, instance.id);
	const files = uploadsOf(req);
	const created = readMusicJob(
		files.length
			? await toolchestUpload(cfg, { path: ROUTES.jobs, body }, files, opts.signal)
			: await toolchestJson(cfg, { method: 'POST', path: ROUTES.jobs, body }, opts.signal)
	);
	if (!created) throw new MusicBackendError('rejected', 'llama-toolchest made no job.');
	opts.onHandle?.({
		backend: 'llama-toolchest',
		baseUrl: cfg.baseUrl,
		id: created.id,
		model: instance.id,
		extra: { keyId: server.keyId() }
	});
	return finish(cfg, created, instance.id, req, opts);
}

/** Follow a job to its end and keep the song. */
async function finish(
	cfg: ToolchestConfig,
	created: MusicJob,
	model: string,
	req: MusicRequest,
	opts: MusicGenerateOptions
): Promise<MusicResult> {
	const job = settleJob(
		await followJob(cfg, created, ROUTES.job, readMusicJob, {
			signal: opts.signal,
			onJob: (j) => opts.onProgress?.(musicProgressOf(j))
		})
	);
	if (!job.audioUrl) throw new MusicBackendError('rejected', 'llama-toolchest gave no audio.');
	opts.onProgress?.({ phase: 'saving' });
	const stored = await storeJobFile(cfg, job.audioUrl, mimeFor(req.format), {
		title: req.title,
		conversationId: opts.conversationId,
		codeSessionId: opts.codeSessionId
	});
	removeJob(cfg, ROUTES.job(job.id));
	return {
		hash: stored.hash,
		url: audioSrc(stored.hash) ?? '',
		mime: stored.mime,
		durationSec: job.result.duration ?? req.durationSec,
		seed: job.result.seed ?? req.seed,
		model,
		bpm: job.result.bpm,
		key: job.result.keyscale
	};
}

export const toolchestMusicBackend: MusicBackend = {
	kind: 'llama-toolchest',

	probe(): Promise<ProbeResult> {
		return server.probe();
	},

	async tasks(): Promise<MusicTask[]> {
		const cfg = await server.config();
		try {
			return knownTasks((await server.readyInstance(cfg)).tasks);
		} catch (e) {
			throw asMusicError(e);
		}
	},

	async generate(req: MusicRequest, opts: MusicGenerateOptions = {}): Promise<MusicResult> {
		const cfg = await server.config();
		try {
			return await run(cfg, req, opts);
		} catch (e) {
			throw asMusicError(e);
		}
	},

	async resume(
		handle: MusicJobHandle,
		req: MusicRequest,
		opts: MusicGenerateOptions = {}
	): Promise<MusicResult> {
		// The server it went to, whatever Settings → Music says now.
		const cfg = await server.configFor(handle.baseUrl, handle.extra?.keyId);
		try {
			return await finish(cfg, readMusicJob({ id: handle.id })!, handle.model, req, opts);
		} catch (e) {
			throw asMusicError(e);
		}
	}
};

registerMusicBackend(toolchestMusicBackend);
