/**
 * acestep.cpp's ace-server, reached directly, as the music backend.
 *
 * A song is two jobs on it: `/lm` composes, `/synth` renders the composed
 * request, and `/job?id=` is polled once a second for each. The result is
 * downloaded straight into the audio cache by Rust (`audio_store_url`, which
 * keeps the audio part of ace-server's multipart answer). Cancelling the turn
 * cancels the job in flight on the server.
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '#lib/stores/settings.ts';
import { sleep } from '#lib/utils/async.ts';
import { registerMusicBackend } from '#lib/music/registry.ts';
import type { MusicBackend, ProbeResult } from '#lib/music/backend.ts';
import {
	MusicBackendError,
	type MusicGenerateOptions,
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

/** Submit one job and follow it to its end; aborting cancels it on the server. */
async function runJob(
	base: string,
	path: string,
	body: unknown,
	phase: MusicProgress['phase'],
	opts: MusicGenerateOptions,
	files: UploadFile[] = []
): Promise<string> {
	const id = readJobId(await aceJson(base, { method: 'POST', path, body }, opts.signal, files));
	if (!id) throw new MusicBackendError('rejected', `ace-server made no ${path.slice(1)} job.`);
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
				if (++failed >= MAX_FAILED_POLLS) throw e;
				continue;
			}
			if (finished(status, phase)) return id;
		}
	} finally {
		opts.signal?.removeEventListener('abort', cancel);
	}
}

async function run(
	base: string,
	req: MusicRequest,
	opts: MusicGenerateOptions
): Promise<MusicResult> {
	const host = hostOf(base);
	const model = chosenModel();
	const p = await props(base, opts.signal);
	const why = unusable(p, model, host);
	if (why) throw new MusicBackendError('unconfigured', why);

	let synthBody;
	let facts: ReturnType<typeof composedFacts> = {
		bpm: req.bpm,
		duration: undefined,
		keyscale: req.key,
		seed: req.seed
	};
	if (onSource(req)) {
		synthBody = buildEditSynthBody(req, model);
	} else {
		const lm = await runJob(base, ROUTES.lm, buildLmBody(req), 'composing', opts);
		const composed = readComposed(await aceJson(base, { path: ROUTES.result(lm) }, opts.signal));
		if (!composed) throw new MusicBackendError('rejected', 'ace-server composed nothing.');
		facts = composedFacts(composed);
		synthBody = buildSynthBody(composed, req.format, model);
	}

	const synth = await runJob(base, ROUTES.synth, synthBody, 'synthesizing', opts, uploadsOf(req));
	opts.onProgress?.({ phase: 'saving' });
	const stored = await invoke<StoredAudio>('audio_store_url', {
		url: `${base}${ROUTES.result(synth)}`,
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
		model: model || p.synthModels[0],
		bpm: facts.bpm,
		key: facts.keyscale
	};
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
			return { ok: false, detail: e instanceof Error ? e.message : String(e) };
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
	}
};

registerMusicBackend(aceMusicBackend);
