/**
 * A llama-toolchest server's ACE-Step instances as the music backend.
 *
 * A song is a job on toolchest's queue (`/v1/music/jobs`): polled once a
 * second for its phase, then downloaded straight into the audio cache by
 * Rust (`audio_store_url`), because toolchest forgets it after a day, and
 * then deleted from the server. Cancelling the turn sends `DELETE`, which ace-server honours mid-song.
 * Instances are started in toolchest; a stopped one is a sentence here.
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '#lib/stores/settings.ts';
import { registerMusicBackend } from '#lib/music/registry.ts';
import type { MusicBackend, ProbeResult } from '#lib/music/backend.ts';
import {
	MusicBackendError,
	type MusicGenerateOptions,
	type MusicRequest,
	type MusicResult,
	type MusicTask
} from '#lib/music/types.ts';
import { knownTasks, uploadsOf } from '#lib/music/tasks.ts';
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
import { followJob, removeJob } from '#lib/toolchest/jobs.ts';
import { audioSrc } from '#lib/audio/url.ts';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import {
	ROUTES,
	buildJobBody,
	mimeFor,
	musicProgressOf,
	readMusicJob,
	type MusicJob
} from '#lib/music/toolchest/adapter.ts';

/** What the last probe saw, for Settings' table. */
let lastInstances: ToolchestInstance[] = [];

async function config(): Promise<ToolchestConfig> {
	const s = getSettings();
	return {
		baseUrl: s.musicToolchestBaseUrl.trim(),
		apiKey: await toolchestKeyFor(s.musicToolchestApiKeyId)
	};
}

function chosenId(): string {
	return (getSettings().musicToolchestModelId ?? '').trim();
}

/** Every music instance the last probe saw. */
export function seenMusicInstances(): ToolchestInstance[] {
	return lastInstances;
}

async function musicInstances(cfg: ToolchestConfig, signal?: AbortSignal) {
	lastInstances = parseGenerationModels(
		await toolchestJson(cfg, { path: ROUTES.models }, signal),
		'music'
	);
	return lastInstances;
}

function asMusicError(e: unknown): unknown {
	if (!(e instanceof ToolchestError)) return e;
	if (e.kind === 'cancelled') return new MusicBackendError('cancelled', 'Cancelled.');
	return new MusicBackendError(e.kind, e.message, { status: e.status });
}

async function readyInstance(cfg: ToolchestConfig, signal?: AbortSignal) {
	if (!cfg.baseUrl) {
		throw new MusicBackendError(
			'unconfigured',
			'No llama-toolchest server is set — Settings → Music.'
		);
	}
	const id = chosenId();
	if (!id)
		throw new MusicBackendError('unconfigured', 'No music model is chosen — Settings → Music.');
	const instance = (await musicInstances(cfg, signal)).find((i) => i.id === id);
	if (!instance) {
		throw new MusicBackendError(
			'unconfigured',
			`${id} is not on ${hostOf(cfg.baseUrl)} any more — Settings → Music.`
		);
	}
	if (instance.state !== 'running') {
		throw new MusicBackendError(
			'unconfigured',
			`${id} is ${instance.state} — start it in llama-toolchest.`
		);
	}
	return instance;
}

/** A finished job, kept in the audio cache. */
async function keep(
	cfg: ToolchestConfig,
	job: MusicJob,
	req: MusicRequest,
	opts: MusicGenerateOptions
): Promise<StoredAudio> {
	if (!job.audioUrl) throw new MusicBackendError('rejected', 'llama-toolchest gave no audio.');
	return invoke<StoredAudio>('audio_store_url', {
		url: `${cfg.baseUrl.replace(/\/+$/, '')}${job.audioUrl}`,
		apiKey: cfg.apiKey || null,
		mimeHint: mimeFor(req.format),
		title: req.title || null,
		conversationId: opts.conversationId ?? null,
		codeSessionId: opts.codeSessionId ?? null
	});
}

async function run(
	cfg: ToolchestConfig,
	req: MusicRequest,
	opts: MusicGenerateOptions
): Promise<MusicResult> {
	const instance = await readyInstance(cfg, opts.signal);
	const body = buildJobBody(req, instance.id);
	const files = uploadsOf(req);
	const created = readMusicJob(
		files.length
			? await toolchestUpload(cfg, { path: ROUTES.jobs, body }, files, opts.signal)
			: await toolchestJson(cfg, { method: 'POST', path: ROUTES.jobs, body }, opts.signal)
	);
	if (!created) throw new MusicBackendError('rejected', 'llama-toolchest made no job.');
	const job = await followJob(cfg, created, ROUTES.job, readMusicJob, {
		signal: opts.signal,
		onJob: (j) => opts.onProgress?.(musicProgressOf(j))
	});
	if (job.status === 'cancelled') throw new MusicBackendError('cancelled', 'Cancelled.');
	if (job.status === 'failed') {
		throw new MusicBackendError('rejected', `llama-toolchest: ${job.error ?? 'the job failed'}`);
	}
	opts.onProgress?.({ phase: 'saving' });
	const stored = await keep(cfg, job, req, opts);
	removeJob(cfg, ROUTES.job(job.id));
	return {
		hash: stored.hash,
		url: audioSrc(stored.hash) ?? '',
		mime: stored.mime,
		durationSec: job.result.duration ?? req.durationSec,
		seed: job.result.seed ?? req.seed,
		model: instance.id,
		bpm: job.result.bpm,
		key: job.result.keyscale
	};
}

export const toolchestMusicBackend: MusicBackend = {
	kind: 'llama-toolchest',

	async probe(): Promise<ProbeResult> {
		const cfg = await config();
		if (!cfg.baseUrl) return { ok: false, detail: 'No server address — Settings → Music.' };
		const host = hostOf(cfg.baseUrl);
		let instances: ToolchestInstance[];
		try {
			instances = await musicInstances(cfg);
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
				detail: `${host} has no music models. Add one in llama-toolchest.`,
				models
			};
		}
		const chosen = instances.find((i) => i.id === chosenId());
		if (!chosen) return { ok: false, detail: 'No model is chosen — Settings → Music.', models };
		if (chosen.state !== 'running') {
			return {
				ok: false,
				detail: `${chosen.id} is ${chosen.state} — start it in llama-toolchest.`,
				models
			};
		}
		return { ok: true, detail: `Connected — ${chosen.id} on ${host}.`, models };
	},

	async tasks(): Promise<MusicTask[]> {
		const cfg = await config();
		try {
			return knownTasks((await readyInstance(cfg)).tasks);
		} catch (e) {
			throw asMusicError(e);
		}
	},

	async generate(req: MusicRequest, opts: MusicGenerateOptions = {}): Promise<MusicResult> {
		const cfg = await config();
		try {
			return await run(cfg, req, opts);
		} catch (e) {
			throw asMusicError(e);
		}
	}
};

registerMusicBackend(toolchestMusicBackend);
