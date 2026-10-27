import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
const settings = vi.hoisted(() => ({
	musicToolchestBaseUrl: 'http://box:3000/',
	musicToolchestApiKeyId: 'k1' as string | null,
	musicToolchestModelId: 'ace-gpu2'
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => settings,
	getApiKeyValue: (id: string) => (id === 'k1' ? 'sekrit' : undefined)
}));
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({ apiKeysReady: () => Promise.resolve() }));
vi.mock('#lib/utils/async.ts', () => ({ sleep: () => Promise.resolve() }));

import compute2 from '#lib/toolchest/fixtures/models-compute2.json';
import asmodean from '#lib/toolchest/fixtures/models-asmodean.json';
import succeeded from './fixtures/job-succeeded.json';
import refused from './fixtures/refused-not-running.json';
import { toolchestMusicBackend } from './backend';
import { invokeRouter } from '#lib/testing/invoke.ts';
import {
	MusicBackendError,
	type MusicJobHandle,
	type MusicProgress,
	type MusicRequest
} from '#lib/music/types.ts';

/** A recorded `/v1/models` with its ACE instance in `state`. */
function musicState(fixture: typeof compute2, state: string) {
	const models = structuredClone(fixture);
	for (const m of models.data) if (m.meta?.kind === 'music') m.meta.state = state;
	return models;
}

interface Call {
	method: string;
	path: string;
	api_key: string;
	body: Record<string, unknown> | null;
}
type Answer = unknown | ((call: Call) => unknown);

const HASH = 'c'.repeat(64);
const JOB = '/v1/music/jobs/3f9a1c0d7e2b4a61';

function use(answers: Record<string, Answer>) {
	tauri.invoke.mockReset().mockImplementation(
		invokeRouter({
			comfy_cancel: null,
			audio_store_url: { hash: HASH, mime: 'audio/mpeg', bytes: 1024 },
			toolchest_json: (args) => answer(answers, args),
			toolchest_upload: (args) => answer(answers, args)
		})
	);
}

function answer(answers: Record<string, Answer>, args: unknown) {
	const call = (args as { call: Call }).call;
	const a = answers[`${call.method} ${call.path}`];
	if (a === undefined) throw { kind: 'rejected', status: 404, body: '{}' };
	return typeof a === 'function' ? (a as (c: Call) => unknown)(call) : a;
}

function jobRoutes(extra: Record<string, Answer> = {}): Record<string, Answer> {
	const states = [
		{ id: '3f9a1c0d7e2b4a61', status: 'queued', phase: 'queued', queue_position: 2 },
		{ id: '3f9a1c0d7e2b4a61', status: 'running', phase: 'composing' },
		{ id: '3f9a1c0d7e2b4a61', status: 'running', phase: 'synthesizing' },
		succeeded
	];
	let n = 0;
	return {
		'GET /v1/models': musicState(compute2, 'running'),
		'POST /v1/music/jobs': states[0],
		[`GET ${JOB}`]: () => states[Math.min(++n, states.length - 1)],
		...extra
	};
}

const request: MusicRequest = {
	title: 'Rain',
	caption: 'lo-fi, rain',
	instrumental: true,
	durationSec: 45,
	seed: 1234,
	format: 'mp3'
};

describe('llama-toolchest music backend', () => {
	beforeEach(() => {
		settings.musicToolchestBaseUrl = 'http://box:3000/';
		settings.musicToolchestModelId = 'ace-gpu2';
		use(jobRoutes());
	});

	it('makes a song through a job and keeps it in the audio cache', async () => {
		const seen: MusicProgress[] = [];
		const result = await toolchestMusicBackend.generate(request, {
			conversationId: 'chat-1',
			onProgress: (p) => seen.push(p)
		});
		expect(seen).toEqual([
			{ phase: 'queued', ahead: 2 },
			{ phase: 'composing' },
			{ phase: 'synthesizing' },
			{ phase: 'saving' }
		]);
		expect(result).toMatchObject({
			hash: HASH,
			mime: 'audio/mpeg',
			durationSec: 45,
			bpm: 82,
			key: 'D minor',
			model: 'ace-gpu2'
		});
		expect(result.url).toContain(HASH);
		const [, stored] = tauri.invoke.mock.calls.find(([c]) => c === 'audio_store_url')!;
		expect(stored).toEqual({
			url: `http://box:3000${JOB}/audio`,
			apiKey: 'sekrit',
			mimeHint: 'audio/mpeg',
			title: 'Rain',
			conversationId: 'chat-1',
			codeSessionId: null
		});
		// Kept in the audio cache, so the server can let go of it.
		const last = tauri.invoke.mock.calls.filter(([c]) => c === 'toolchest_json').at(-1)!;
		expect(`${last[1].call.method} ${last[1].call.path}`).toBe(`DELETE ${JOB}`);
	});

	it('cancels the job on the server when the turn is cancelled', async () => {
		const controller = new AbortController();
		use(
			jobRoutes({
				[`GET ${JOB}`]: () => {
					controller.abort();
					return { id: '3f9a1c0d7e2b4a61', status: 'running', phase: 'composing' };
				},
				[`DELETE ${JOB}`]: null
			})
		);
		await expect(
			toolchestMusicBackend.generate(request, { signal: controller.signal })
		).rejects.toMatchObject({ kind: 'cancelled' });
		const paths = tauri.invoke.mock.calls
			.filter(([c]) => c === 'toolchest_json')
			.map(([, a]) => `${a.call.method} ${a.call.path}`);
		expect(paths).toContain(`DELETE ${JOB}`);
	});

	it('says a stopped instance is stopped, before queuing anything', async () => {
		use({ 'GET /v1/models': musicState(compute2, 'stopped') });
		const err = await toolchestMusicBackend.generate(request).catch((e) => e);
		expect(err).toBeInstanceOf(MusicBackendError);
		expect(err.message).toBe('ace-gpu2 is stopped — start it in llama-toolchest.');
	});

	it('passes on a failed job and toolchest’s own refusal', async () => {
		use(
			jobRoutes({
				[`GET ${JOB}`]: { id: '3f9a1c0d7e2b4a61', status: 'failed', error: 'synthesizing: boom' }
			})
		);
		await expect(toolchestMusicBackend.generate(request)).rejects.toThrow(
			'llama-toolchest: synthesizing: boom'
		);
		use(
			jobRoutes({
				'POST /v1/music/jobs': () => {
					throw { kind: 'rejected', status: 503, body: JSON.stringify(refused) };
				}
			})
		);
		await expect(toolchestMusicBackend.generate(request)).rejects.toThrow(
			/backend ace-gpu2 is not running/
		);
	});

	it('probes into a sentence and lists music instances only', async () => {
		settings.musicToolchestModelId = 'ace-xl';
		use({ 'GET /v1/models': musicState(asmodean, 'stopped') });
		expect(await toolchestMusicBackend.probe()).toEqual({
			ok: false,
			detail: 'ace-xl is stopped — start it in llama-toolchest.',
			models: [{ name: 'ace-xl', label: 'ace-xl — stopped' }]
		});
		use({ 'GET /v1/models': musicState(asmodean, 'running') });
		expect((await toolchestMusicBackend.probe()).detail).toBe('Connected — ace-xl on box:3000.');
	});

	it('sends a task on a song as a multipart job, with no length', async () => {
		const source = { name: 'song.mp3', hash: 'a'.repeat(64) };
		await toolchestMusicBackend.generate({
			...request,
			task: 'cover',
			coverStrength: 0.3,
			lyrics: 'la la',
			instrumental: false,
			source
		});
		const [, args] = tauri.invoke.mock.calls.find(([c]) => c === 'toolchest_upload')!;
		expect(args.call).toMatchObject({ method: 'POST', path: '/v1/music/jobs' });
		expect(args.call.body).toMatchObject({
			model: 'ace-gpu2',
			task_type: 'cover',
			audio_cover_strength: 0.3,
			lyrics: 'la la'
		});
		expect(args.call.body).not.toHaveProperty('duration');
		expect(args.files).toEqual([
			{ field: 'audio', filename: 'song.mp3', hash: 'a'.repeat(64), cache: 'audio', bytes: null }
		]);
		expect(
			tauri.invoke.mock.calls.some(
				([c, a]) => c === 'toolchest_json' && a.call.path === '/v1/music/jobs'
			)
		).toBe(false);
	});

	it('lists the tasks the chosen model runs, or text2music from an older build', async () => {
		expect(await toolchestMusicBackend.tasks()).toEqual(['text2music']);
		const models = musicState(compute2, 'running');
		for (const m of models.data) {
			if (m.meta?.kind === 'music')
				Object.assign(m.meta, { tasks: ['text2music', 'cover', 'repaint'] });
		}
		use({ 'GET /v1/models': models });
		expect(await toolchestMusicBackend.tasks()).toEqual(['text2music', 'cover', 'repaint']);
	});
});

describe('llama-toolchest music jobs after a restart', () => {
	beforeEach(() => {
		settings.musicToolchestBaseUrl = 'http://box:3000/';
		settings.musicToolchestApiKeyId = 'k1';
		settings.musicToolchestModelId = 'ace-gpu2';
		use(jobRoutes());
	});

	it('reports the job it sent, with the server, instance and key', async () => {
		const handles: MusicJobHandle[] = [];
		await toolchestMusicBackend.generate(request, { onHandle: (h) => handles.push(h) });
		expect(handles).toEqual([
			{
				backend: 'llama-toolchest',
				baseUrl: 'http://box:3000/',
				id: '3f9a1c0d7e2b4a61',
				model: 'ace-gpu2',
				extra: { keyId: 'k1' }
			}
		]);
	});

	it('follows the job on the server it went to, whatever Settings → Music says now', async () => {
		settings.musicToolchestBaseUrl = 'http://elsewhere:3000/';
		settings.musicToolchestApiKeyId = null;
		const handle: MusicJobHandle = {
			backend: 'llama-toolchest',
			baseUrl: 'http://box:3000/',
			id: '3f9a1c0d7e2b4a61',
			model: 'ace-gpu2',
			extra: { keyId: 'k1' }
		};
		const result = await toolchestMusicBackend.resume!(handle, request, {
			codeSessionId: 'code-1'
		});
		expect(result).toMatchObject({ hash: HASH, model: 'ace-gpu2', bpm: 82 });
		// Polls of the job, then its delete once the song is kept; nothing is sent again.
		const calls = tauri.invoke.mock.calls
			.filter(([c]) => c === 'toolchest_json')
			.map(([, a]) => `${a.call.method} ${a.call.path}`);
		expect(new Set(calls)).toEqual(new Set([`GET ${JOB}`, `DELETE ${JOB}`]));
		expect(calls.at(-1)).toBe(`DELETE ${JOB}`);
		const [, stored] = tauri.invoke.mock.calls.find(([c]) => c === 'audio_store_url')!;
		expect(stored).toMatchObject({
			url: `http://box:3000${JOB}/audio`,
			apiKey: 'sekrit',
			codeSessionId: 'code-1'
		});
	});

	it('passes on a 404 for a job the server no longer has', async () => {
		use({});
		const handle: MusicJobHandle = {
			backend: 'llama-toolchest',
			baseUrl: 'http://box:3000/',
			id: 'gone',
			model: 'ace-gpu2'
		};
		await expect(toolchestMusicBackend.resume!(handle, request)).rejects.toMatchObject({
			status: 404
		});
	});
});
