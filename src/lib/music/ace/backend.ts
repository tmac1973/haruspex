/**
 * acestep.cpp's ace-server, reached directly, as the music backend.
 *
 * A song is two jobs on it: `/lm` composes, `/synth` renders the composed
 * request, and `/job?id=` is polled once a second for each. The result is
 * downloaded straight into the audio cache by Rust (`audio_store_url`, which
 * keeps the audio part of ace-server's multipart answer). Cancelling the turn
 * cancels the job in flight on the server. Each job's id is reported
 * (`onHandle`), so `resume` can pick the song up after a restart at
 * whichever of the two it had reached.
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '#lib/stores/settings.ts';
import { sleep } from '#lib/utils/async.ts';
import { registerMusicBackend } from '#lib/music/registry.ts';
import type { MusicBackend, ProbeResult } from '#lib/music/backend.ts';
import {
	MusicBackendError,
	type MusicGenerateOptions,
	type MusicJobHandle,
	type MusicProgress,
	type MusicRequest,
	type MusicResult,
	type MusicTask
} from '#lib/music/types.ts';
import { onSource, uploadsOf } from '#lib/music/tasks.ts';
import type { UploadFile } from '#lib/ipc/gen/UploadFile.ts';
import { hostOf } from '#lib/toolchest/client.ts';
import { mimeFor } from '#lib/music/toolchest/adapter.ts';
import { audioSrc } from '#lib/audio/url.ts';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import { aceJson } from '#lib/music/ace/client.ts';
import {
	ROUTES,
	buildEditSynthBody,
	buildLmBody,
	buildSynthBody,
	composedFacts,
	readComposed,
	readJobId,
	readProps,
	readStatus,
	tasksFor,
	type AceProps,
	type AceStatus
} from '#lib/music/ace/adapter.ts';
import { errMessage } from '#lib/utils/error.ts';

const POLL_MS = 1000;
/** Polls in a row that may fail before the server counts as gone. */
const MAX_FAILED_POLLS = 20;

function baseUrl(): string {
	return getSettings().musicAceBaseUrl.trim().replace(/\/+$/, '');
}

/** The synthesis model asked for; empty for the server's own. */
function chosenModel(): string {
	return (getSettings().musicAceModel ?? '').trim();
}

async function props(base: string, signal?: AbortSignal): Promise<AceProps> {
	const p = readProps(await aceJson(base, { path: ROUTES.props }, signal));
	if (!p) throw new MusicBackendError('rejected', `${hostOf(base)} is not an ace-server.`);
	return p;
}

/** Why the server can't make a song with the chosen model, if it can't. */
function unusable(p: AceProps, model: string, host: string): string | null {
	if (p.lmModels.length === 0) return `${host} has no composing model loaded.`;
	if (p.synthModels.length === 0) return `${host} has no synthesis model loaded.`;
	if (model && !p.synthModels.includes(model)) {
		return `${model} is not on ${host} any more — Settings → Music.`;
	}
	return null;
}

/** True once a job is done; throws if it ended any other way. */
function finished(status: AceStatus, phase: MusicProgress['phase']): boolean {
	if (status === 'cancelled') throw new MusicBackendError('cancelled', 'Cancelled.');
	if (status === 'failed') {
		const step = phase === 'composing' ? 'composing' : 'synthesis';
		throw new MusicBackendError('rejected', `ace-server: ${step} failed.`);
	}
	return status === 'done';
}

/** Send one job; its id. */
async function submitJob(
	base: string,
	path: string,
	body: unknown,
	opts: MusicGenerateOptions,
	files: UploadFile[] = []
): Promise<string> {
	const id = readJobId(await aceJson(base, { method: 'POST', path, body }, opts.signal, files));
	if (!id) throw new MusicBackendError('rejected', `ace-server made no ${path.slice(1)} job.`);
	return id;
}

/** Follow a job to its end; aborting cancels it on the server. */
async function followAceJob(
	base: string,
	id: string,
	phase: MusicProgress['phase'],
	opts: MusicGenerateOptions
): Promise<void> {
	const cancel = () =>
		void aceJson(base, { method: 'POST', path: ROUTES.cancel(id) }).catch(() => {});
	opts.signal?.addEventListener('abort', cancel, { once: true });
	try {
		let failed = 0;
		for (;;) {
			opts.onProgress?.({ phase });
			await sleep(POLL_MS);
			if (opts.signal?.aborted) throw new MusicBackendError('cancelled', 'Cancelled.');
			let status;
			try {
				status = readStatus(await aceJson(base, { path: ROUTES.job(id) }, opts.signal));
				failed = 0;
			} catch (e) {
				if (e instanceof MusicBackendError && e.kind === 'cancelled') throw e;
				// A job the server doesn't know is gone, not a server that is down.
				if (e instanceof MusicBackendError && e.status === 404) throw e;
				if (++failed >= MAX_FAILED_POLLS) throw e;
				continue;
			}
			if (finished(status, phase)) return;
		}
	} finally {
		opts.signal?.removeEventListener('abort', cancel);
	}
}

type Facts = NonNullable<MusicJobHandle['facts']>;

/** Where a song is going: the server, and the model as sent and as reported. */
interface AceTarget {
	base: string;
	/** The synthesis model asked for; empty for the server's own. */
	synthModel: string;
	/** What the result names. */
	model: string;
}

function handleOf(t: AceTarget, id: string, stage: 'lm' | 'synth', facts?: Facts): MusicJobHandle {
	return {
		backend: 'ace-server',
		baseUrl: t.base,
		id,
		model: t.model,
		stage,
		...(facts ? { facts } : {}),
		extra: { synthModel: t.synthModel }
	};
}

/** Render the composed song, once the composing job `lm` has finished. */
async function synthesize(
	t: AceTarget,
	lm: string,
	req: MusicRequest,
	opts: MusicGenerateOptions
): Promise<MusicResult> {
	const composed = readComposed(await aceJson(t.base, { path: ROUTES.result(lm) }, opts.signal));
	if (!composed) throw new MusicBackendError('rejected', 'ace-server composed nothing.');
	const facts = composedFacts(composed);
	const body = buildSynthBody(composed, req.format, t.synthModel);
	const synth = await submitJob(t.base, ROUTES.synth, body, opts);
	opts.onHandle?.(handleOf(t, synth, 'synth', facts));
	return render(t, synth, facts, req, opts);
}

/** Follow the `synth` job and keep the song. */
async function render(
	t: AceTarget,
	synth: string,
	facts: Facts,
	req: MusicRequest,
	opts: MusicGenerateOptions
): Promise<MusicResult> {
	await followAceJob(t.base, synth, 'synthesizing', opts);
	opts.onProgress?.({ phase: 'saving' });
	const stored = await invoke<StoredAudio>('audio_store_url', {
		url: `${t.base}${ROUTES.result(synth)}`,
		apiKey: null,
		mimeHint: mimeFor(req.format),
		title: req.title || null,
		conversationId: opts.conversationId ?? null,
		codeSessionId: opts.codeSessionId ?? null
	});
	return {
		hash: stored.hash,
		url: audioSrc(stored.hash) ?? '',
		mime: stored.mime,
		durationSec: facts.duration ?? req.durationSec,
		seed: facts.seed ?? req.seed,
		model: t.model,
		bpm: facts.bpm,
		key: facts.keyscale
	};
}

async function run(
	base: string,
	req: MusicRequest,
	opts: MusicGenerateOptions
): Promise<MusicResult> {
	const host = hostOf(base);
	const synthModel = chosenModel();
	const p = await props(base, opts.signal);
	const why = unusable(p, synthModel, host);
	if (why) throw new MusicBackendError('unconfigured', why);
	const t: AceTarget = { base, synthModel, model: synthModel || p.synthModels[0] };

	if (onSource(req)) {
		const facts: Facts = { bpm: req.bpm, keyscale: req.key, seed: req.seed };
		const body = buildEditSynthBody(req, synthModel);
		const synth = await submitJob(base, ROUTES.synth, body, opts, uploadsOf(req));
		opts.onHandle?.(handleOf(t, synth, 'synth', facts));
		return render(t, synth, facts, req, opts);
	}
	const lm = await submitJob(base, ROUTES.lm, buildLmBody(req), opts);
	opts.onHandle?.(handleOf(t, lm, 'lm'));
	await followAceJob(base, lm, 'composing', opts);
	return synthesize(t, lm, req, opts);
}

export const aceMusicBackend: MusicBackend = {
	kind: 'ace-server',

	async probe(): Promise<ProbeResult> {
		const base = baseUrl();
		if (!base) return { ok: false, detail: 'No server address — Settings → Music.' };
		const host = hostOf(base);
		let p: AceProps;
		try {
			p = await props(base);
		} catch (e) {
			if (e instanceof MusicBackendError && e.kind === 'unreachable') {
				return { ok: false, detail: `Can't reach ${host}.` };
			}
			return { ok: false, detail: errMessage(e) };
		}
		const models = p.synthModels.map((name) => ({ name, label: name }));
		const model = chosenModel();
		const why = unusable(p, model, host);
		if (why) return { ok: false, detail: why, models };
		return { ok: true, detail: `Connected — ${model || p.synthModels[0]} on ${host}.`, models };
	},

	async tasks(): Promise<MusicTask[]> {
		const base = baseUrl();
		if (!base) return [];
		const p = await props(base);
		return tasksFor(chosenModel() || p.synthModels[0] || '');
	},

	generate(req: MusicRequest, opts: MusicGenerateOptions = {}): Promise<MusicResult> {
		const base = baseUrl();
		if (!base) {
			return Promise.reject(
				new MusicBackendError('unconfigured', 'No ace-server is set — Settings → Music.')
			);
		}
		return run(base, req, opts);
	},

	async resume(
		handle: MusicJobHandle,
		req: MusicRequest,
		opts: MusicGenerateOptions = {}
	): Promise<MusicResult> {
		// The server it went to, whatever Settings → Music says now.
		const t: AceTarget = {
			base: handle.baseUrl,
			synthModel: handle.extra?.synthModel ?? '',
			model: handle.model
		};
		if (handle.stage === 'lm') {
			await followAceJob(t.base, handle.id, 'composing', opts);
			return synthesize(t, handle.id, req, opts);
		}
		return render(t, handle.id, handle.facts ?? {}, req, opts);
	}
};

registerMusicBackend(aceMusicBackend);
