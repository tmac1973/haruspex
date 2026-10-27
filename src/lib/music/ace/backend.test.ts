import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
const settings = vi.hoisted(() => ({
	musicAceBaseUrl: 'http://box:8083/',
	musicAceModel: ''
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, { settings })
);
vi.mock('#lib/utils/async.ts', () => ({ sleep: () => Promise.resolve() }));

import asmodean from './fixtures/props-asmodean.json';
import composed from './fixtures/lm-result.json';
import { aceMusicBackend } from './backend';
import { httpRouter, invokeRouter, type HttpAnswer } from '#lib/testing/invoke.ts';
import {
	MusicBackendError,
	type MusicJobHandle,
	type MusicProgress,
	type MusicRequest
} from '#lib/music/types.ts';

type Answer = HttpAnswer;

const HASH = 'c'.repeat(64);
const DIT = 'acestep-v15-xl-sft-Q8_0.gguf';

function use(answers: Record<string, Answer>) {
	tauri.invoke.mockReset().mockImplementation(
		invokeRouter({
			comfy_cancel: null,
			audio_store_url: { hash: HASH, mime: 'audio/mpeg', bytes: 1024 },
			ace_json: httpRouter(answers, NOPE),
			ace_upload: httpRouter(answers, NOPE)
		})
	);
}

const NOPE = '{"error":"nope"}';

/** A server that composes as `lm`, then synthesizes as `syn`, each running once. */
function songRoutes(extra: Record<string, Answer> = {}): Record<string, Answer> {
	const once = () => {
		let n = 0;
		return () => ({ status: n++ === 0 ? 'running' : 'done' });
	};
	return {
		'GET /props': asmodean,
		'POST /lm': { id: 'lm' },
		'GET /job?id=lm': once(),
		'GET /job?id=lm&result=1': composed,
		'POST /synth': { id: 'syn' },
		'GET /job?id=syn': once(),
		...extra
	};
}

function sent(method: string, path: string) {
	const found = tauri.invoke.mock.calls.find(
		([c, a]) => c === 'ace_json' && a.call.method === method && a.call.path === path
	);
	return found?.[1].call.body as Record<string, unknown> | undefined;
}

const request: MusicRequest = {
	title: 'Rain',
	caption: 'lo-fi, rain',
	instrumental: true,
	durationSec: 15,
	seed: 42,
	format: 'wav'
};

describe('ace-server music backend', () => {
	beforeEach(() => {
		settings.musicAceBaseUrl = 'http://box:8083/';
		settings.musicAceModel = '';
		use(songRoutes());
	});

	it('composes, synthesizes the composed request, and keeps the song', async () => {
		const seen: MusicProgress[] = [];
		const result = await aceMusicBackend.generate(request, {
			conversationId: 'chat-1',
			onProgress: (p) => seen.push(p)
		});
		expect([...new Set(seen.map((p) => p.phase))]).toEqual(['composing', 'synthesizing', 'saving']);
		expect(sent('POST', '/lm')).toEqual({
			caption: 'lo-fi, rain',
			lyrics: '[Instrumental]',
			duration: 15,
			seed: 42,
			lm_seed: 42,
			use_cot_caption: false
		});
		// The composed request goes on whole, audio codes and all.
		expect(sent('POST', '/synth')).toEqual({ ...composed[0], output_format: 'wav16' });
		expect(result).toMatchObject({
			hash: HASH,
			durationSec: 15,
			seed: 42,
			bpm: 86,
			key: 'C major',
			model: DIT
		});
		const [, stored] = tauri.invoke.mock.calls.find(([c]) => c === 'audio_store_url')!;
		expect(stored).toEqual({
			url: 'http://box:8083/job?id=syn&result=1',
			apiKey: null,
			mimeHint: 'audio/wav',
			title: 'Rain',
			conversationId: 'chat-1',
			codeSessionId: null
		});
	});

	it('names the chosen model to synthesis', async () => {
		settings.musicAceModel = DIT;
		await aceMusicBackend.generate(request);
		expect(sent('POST', '/synth')?.synth_model).toBe(DIT);
	});

	it('cancels the job in flight on the server when the turn is cancelled', async () => {
		const controller = new AbortController();
		use(
			songRoutes({
				'GET /job?id=lm': () => {
					controller.abort();
					return { status: 'running' };
				},
				'POST /job?id=lm&cancel=1': { status: 'cancelled' }
			})
		);
		await expect(
			aceMusicBackend.generate(request, { signal: controller.signal })
		).rejects.toMatchObject({ kind: 'cancelled' });
		expect(tauri.invoke.mock.calls.some(([, a]) => a?.call?.path === '/job?id=lm&cancel=1')).toBe(
			true
		);
		expect(sent('POST', '/synth')).toBeUndefined();
	});

	it('says which stage failed', async () => {
		use(songRoutes({ 'GET /job?id=syn': { status: 'failed' } }));
		await expect(aceMusicBackend.generate(request)).rejects.toThrow(
			'ace-server: synthesis failed.'
		);
	});

	it('refuses a model the server does not have, before starting a job', async () => {
		settings.musicAceModel = 'gone.gguf';
		const err = await aceMusicBackend.generate(request).catch((e) => e);
		expect(err).toBeInstanceOf(MusicBackendError);
		expect(err.message).toBe('gone.gguf is not on box:8083 any more — Settings → Music.');
		expect(sent('POST', '/lm')).toBeUndefined();
	});

	it('probes into a sentence and lists the synthesis models', async () => {
		expect(await aceMusicBackend.probe()).toEqual({
			ok: true,
			detail: `Connected — ${DIT} on box:8083.`,
			models: [{ name: DIT, label: DIT }]
		});
		use({ 'GET /props': { status: 'ok' } });
		expect((await aceMusicBackend.probe()).detail).toBe('box:8083 is not an ace-server.');
		use({
			'GET /props': () => {
				throw { kind: 'unreachable', message: 'down' };
			}
		});
		expect((await aceMusicBackend.probe()).detail).toBe("Can't reach box:8083.");
		settings.musicAceBaseUrl = ' ';
		expect((await aceMusicBackend.probe()).detail).toBe('No server address — Settings → Music.');
	});

	it('sends a task on a song straight to /synth with the song, skipping composing', async () => {
		const seen: MusicProgress[] = [];
		const result = await aceMusicBackend.generate(
			{
				...request,
				task: 'repaint',
				repaintStart: 30,
				repaintEnd: 50,
				durationSec: 50,
				source: { name: 'song.mp3', hash: 'a'.repeat(64) },
				reference: { name: 'voice.wav', bytes: [1, 2] }
			},
			{ onProgress: (p) => seen.push(p) }
		);
		expect(sent('POST', '/lm')).toBeUndefined();
		expect([...new Set(seen.map((p) => p.phase))]).toEqual(['synthesizing', 'saving']);
		const [, args] = tauri.invoke.mock.calls.find(([c]) => c === 'ace_upload')!;
		expect(args.call).toMatchObject({ method: 'POST', path: '/synth' });
		expect(args.call.body).toEqual({
			caption: 'lo-fi, rain',
			lyrics: '[Instrumental]',
			seed: 42,
			output_format: 'wav16',
			task_type: 'repaint',
			repainting_start: 30,
			repainting_end: 50
		});
		expect(args.files.map((f: { field: string }) => f.field)).toEqual(['audio', 'ref_audio']);
		expect(result).toMatchObject({ durationSec: 50, seed: 42 });
	});

	it('runs every task on a base model, and no instrument tasks on SFT or turbo', async () => {
		// The recorded server loaded XL SFT.
		expect(await aceMusicBackend.tasks()).toEqual(['text2music', 'cover', 'repaint']);
		settings.musicAceModel = 'acestep-v15-turbo-Q8_0.gguf';
		expect(await aceMusicBackend.tasks()).toEqual(['text2music', 'cover', 'repaint']);
		settings.musicAceModel = 'acestep-v15-xl-base-Q8_0.gguf';
		expect(await aceMusicBackend.tasks()).toEqual([
			'text2music',
			'cover',
			'repaint',
			'lego',
			'extract',
			'complete'
		]);
	});
});

describe('ace-server music jobs after a restart', () => {
	beforeEach(() => {
		settings.musicAceBaseUrl = 'http://box:8083/';
		settings.musicAceModel = '';
		use(songRoutes());
	});

	it('reports the composing job, then the synthesis job with what composing settled', async () => {
		const handles: MusicJobHandle[] = [];
		await aceMusicBackend.generate(request, { onHandle: (h) => handles.push(h) });
		expect(handles).toEqual([
			{
				backend: 'ace-server',
				baseUrl: 'http://box:8083',
				id: 'lm',
				model: DIT,
				stage: 'lm',
				extra: { synthModel: '' }
			},
			{
				backend: 'ace-server',
				baseUrl: 'http://box:8083',
				id: 'syn',
				model: DIT,
				stage: 'synth',
				facts: { bpm: 86, duration: 15, keyscale: 'C major', seed: 42 },
				extra: { synthModel: '' }
			}
		]);
	});

	it('picks up while composing: waits for it, then synthesizes', async () => {
		settings.musicAceBaseUrl = 'http://elsewhere:8083/';
		const handles: MusicJobHandle[] = [];
		const result = await aceMusicBackend.resume!(
			{
				backend: 'ace-server',
				baseUrl: 'http://box:8083',
				id: 'lm',
				model: DIT,
				stage: 'lm',
				extra: { synthModel: '' }
			},
			request,
			{ onHandle: (h) => handles.push(h) }
		);
		expect(sent('POST', '/lm')).toBeUndefined();
		expect(sent('POST', '/synth')).toEqual({ ...composed[0], output_format: 'wav16' });
		expect(handles.map((h) => h.stage)).toEqual(['synth']);
		expect(result).toMatchObject({ hash: HASH, bpm: 86, key: 'C major', model: DIT });
	});

	it('picks up while synthesizing: follows it and keeps the song', async () => {
		const result = await aceMusicBackend.resume!(
			{
				backend: 'ace-server',
				baseUrl: 'http://box:8083',
				id: 'syn',
				model: DIT,
				stage: 'synth',
				facts: { bpm: 90, keyscale: 'A minor', seed: 7 }
			},
			request
		);
		expect(sent('POST', '/synth')).toBeUndefined();
		expect(result).toMatchObject({ hash: HASH, bpm: 90, key: 'A minor', seed: 7, durationSec: 15 });
	});

	it('passes on a 404 at once for a job the server no longer has', async () => {
		use({});
		await expect(
			aceMusicBackend.resume!(
				{ backend: 'ace-server', baseUrl: 'http://box:8083', id: 'x', model: DIT, stage: 'synth' },
				request
			)
		).rejects.toMatchObject({ status: 404 });
		const polls = tauri.invoke.mock.calls.filter(([c]) => c === 'ace_json');
		expect(polls).toHaveLength(1);
	});
});
