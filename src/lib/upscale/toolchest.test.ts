import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import vupscale from '#lib/toolchest/fixtures/models-vupscale.json';
import { httpRouter, invokeRouter } from '#lib/testing/invoke.ts';
import { ToolchestError } from '#lib/toolchest/client.ts';
import type { ToolchestInstance } from '#lib/toolchest/models.ts';
import type { UpscalerEntry } from '#lib/upscale/types.ts';

const settings = vi.hoisted(() => ({
	imageUpscalers: [] as UpscalerEntry[],
	videoUpscalers: [] as UpscalerEntry[]
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => settings,
		updateSettings: vi.fn((patch: object) => Object.assign(settings, patch)),
		apiKeys: { k1: 'sekrit' }
	})
);
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({ apiKeysReady: async () => {} }));
vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { probeUpscaler, readyUpscaler, upscalerCaps, upscalersIn } from './toolchest.ts';

/** A `/v1/models` entry toolchest lists for a generation instance. */
function listed(id: string, meta: Record<string, unknown>) {
	return { id, object: 'model', owned_by: 'llama-toolchest', meta };
}

/** A server with picture upscalers, a chat model and an image model beside them. */
const images = {
	object: 'list',
	data: [
		{ id: 'qwen', object: 'model', owned_by: 'llamacpp' },
		listed('ming', { kind: 'image', state: 'running', api: ['images.jobs'] }),
		listed('esrgan-x4', {
			kind: 'upscale',
			state: 'running',
			api: ['images.upscale'],
			scale: 4
		}),
		listed('esrgan-x2', {
			kind: 'upscale',
			state: 'stopped',
			api: ['images.upscale'],
			scale: 2
		}),
		listed('broken', { kind: 'upscale', state: 'failed', api: ['images.upscale'] }),
		// Listed as an upscaler, but this build can't drive it.
		listed('no-route', { kind: 'upscale', state: 'running', api: ['images.jobs'] }),
		// Upscalers always list `meta.api`: one without it has no route.
		listed('old', { kind: 'upscale', state: 'running', scale: 2 })
	]
};

function entry(over: Partial<UpscalerEntry> = {}): UpscalerEntry {
	return {
		id: 'u1',
		name: 'Upscaler',
		backend: 'llama-toolchest',
		url: 'http://gpu.lan:3000',
		keyId: null,
		model: 'esrgan-x4',
		options: {},
		caps: null,
		capsAt: null,
		renamed: false,
		...over
	};
}

/** The server answers `/v1/models` with `json`. */
function serve(json: unknown) {
	vi.mocked(invoke).mockImplementation(
		invokeRouter({ toolchest_json: httpRouter({ 'GET /v1/models': json }) })
	);
}

/** The server's `/v1/models` fails as Rust reports `err`. */
function fail(err: unknown) {
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			toolchest_json: () => {
				throw err;
			}
		})
	);
}

async function refusal(p: Promise<unknown>): Promise<ToolchestError> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(ToolchestError);
		return e as ToolchestError;
	}
	throw new Error('expected a rejection');
}

const instance = (over: Partial<ToolchestInstance>): ToolchestInstance => ({
	id: 'x',
	modelSet: '',
	recipe: '',
	capabilities: [],
	state: 'running',
	api: [],
	tasks: [],
	maxEditImages: null,
	scale: null,
	video: null,
	vupscale: null,
	licence: 'unknown',
	commercialUse: null,
	...over
});

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	settings.imageUpscalers = [entry()];
	settings.videoUpscalers = [entry({ model: 'relayvsr-x2' })];
});

describe('upscalersIn', () => {
	it('keeps the picture upscalers this build can drive, in the order listed', () => {
		const ups = upscalersIn('image', images);
		expect(ups.map((i) => i.id)).toEqual(['esrgan-x4', 'esrgan-x2', 'broken']);
		expect(ups[0]).toMatchObject({ state: 'running', scale: 4, vupscale: null });
		expect(ups[2]).toMatchObject({ state: 'failed', scale: null });
	});

	it('keeps the video upscalers apart from the video models', () => {
		const ups = upscalersIn('video', vupscale);
		expect(ups.map((i) => i.id)).toEqual([
			'relayvsr-x2',
			'relayvsr-x4',
			'seedvr2-3b',
			'seedvr2-7b-sharp'
		]);
		expect(upscalersIn('image', vupscale)).toEqual([]);
		expect(upscalersIn('video', images)).toEqual([]);
	});

	it('finds none in an empty list or an answer of the wrong shape', () => {
		for (const json of [
			{ data: [] },
			{},
			{ data: 'nope' },
			null,
			'text',
			42,
			[listed('a', { kind: 'upscale', api: ['images.upscale'] })]
		]) {
			expect(upscalersIn('image', json)).toEqual([]);
		}
	});

	it('passes over entries with no id, and reads wrongly typed fields as missing', () => {
		const json = {
			data: [
				listed('', { kind: 'upscale', api: ['images.upscale'] }),
				{ owned_by: 'llama-toolchest', meta: { kind: 'upscale', api: ['images.upscale'] } },
				listed('odd', {
					kind: 'upscale',
					api: ['images.upscale', 7, null],
					state: 3,
					scale: 'four'
				}),
				listed('neg', { kind: 'upscale', api: ['images.upscale'], scale: -2 }),
				listed('notapi', { kind: 'upscale', api: 'images.upscale' }),
				'junk',
				null
			]
		};
		const ups = upscalersIn('image', json);
		expect(ups.map((i) => i.id)).toEqual(['odd', 'neg']);
		expect(ups[0]).toMatchObject({ state: 'unknown', scale: null, api: ['images.upscale'] });
		expect(ups[1].scale).toBeNull();
	});
});

describe('upscalerCaps', () => {
	it('keeps a picture upscaler’s scale, ×4 when it lists none', () => {
		expect(upscalerCaps('image', instance({ scale: 2 }))).toEqual({ scale: 2, limits: null });
		expect(upscalerCaps('image', instance({ scale: null }))).toEqual({ scale: 4, limits: null });
	});

	it('keeps a video upscaler’s limits and their scale', () => {
		const [x2, x4] = upscalersIn('video', vupscale);
		expect(upscalerCaps('video', x2)).toEqual({ scale: 2, limits: x2.vupscale });
		expect(upscalerCaps('video', x4)).toMatchObject({
			scale: 4,
			limits: { measuredWidth: 512, measuredHeight: 288 }
		});
	});

	it('falls back to the listed scale, then ×2, for a video upscaler without limits', () => {
		expect(upscalerCaps('video', instance({ scale: 3 }))).toEqual({ scale: 3, limits: null });
		expect(upscalerCaps('video', instance({}))).toEqual({ scale: 2, limits: null });
	});

	it('reads ×2 for a video upscaler whose listing gives no scale anywhere', () => {
		const json = { data: [listed('vsr', { kind: 'vupscale', api: ['video.upscale.jobs'] })] };
		const [vsr] = upscalersIn('video', json);
		expect(upscalerCaps('video', vsr)).toMatchObject({
			scale: 2,
			limits: { measuredWidth: null, measuredHeight: null, measuredFrames: null }
		});
	});
});

describe('probeUpscaler', () => {
	it('connects to a running upscaler, lists the rest, and saves what it learned', async () => {
		serve(images);
		const p = await probeUpscaler('image', entry());
		expect(p).toEqual({
			ok: true,
			detail: 'Connected — esrgan-x4 on gpu.lan:3000.',
			models: [
				{ name: 'esrgan-x4', label: 'esrgan-x4' },
				{ name: 'esrgan-x2', label: 'esrgan-x2 — stopped' },
				{ name: 'broken', label: 'broken — failed' }
			],
			caps: { scale: 4, limits: null }
		});
		expect(settings.imageUpscalers[0].caps).toEqual({ scale: 4, limits: null });
	});

	it('says a stopped upscaler starts when used', async () => {
		serve(images);
		const p = await probeUpscaler('image', entry({ model: ' esrgan-x2 ' }));
		expect(p).toMatchObject({
			ok: true,
			detail: 'Connected — esrgan-x2 on gpu.lan:3000 (stopped: it starts when used).',
			caps: { scale: 2, limits: null }
		});
	});

	it('saves a video upscaler’s measured limits', async () => {
		serve(vupscale);
		const p = await probeUpscaler('video', entry({ model: 'relayvsr-x2' }));
		expect(p.ok).toBe(true);
		expect(settings.videoUpscalers[0].caps).toMatchObject({
			scale: 2,
			limits: { measuredWidth: 832, measuredHeight: 480, measuredFrames: 81 }
		});
	});

	it('sends the entry’s key', async () => {
		serve(images);
		await probeUpscaler('image', entry({ keyId: 'k1' }));
		const sent = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'toolchest_json');
		expect((sent?.[1] as { call: { api_key: string } }).call.api_key).toBe('sekrit');
	});

	it('wants a server address before asking anything', async () => {
		const p = await probeUpscaler('image', entry({ url: '  ' }));
		expect(p).toEqual({ ok: false, detail: 'No server address.', models: [] });
	});

	it('says the key is wrong on a 401', async () => {
		fail({ kind: 'rejected', status: 401, body: '' });
		expect(await probeUpscaler('image', entry())).toEqual({
			ok: false,
			detail: 'Wrong or missing API key.',
			models: []
		});
	});

	it('says the server can’t be reached', async () => {
		fail({ kind: 'unreachable', message: 'connection refused' });
		expect(await probeUpscaler('image', entry())).toEqual({
			ok: false,
			detail: "Can't reach gpu.lan:3000.",
			models: []
		});
	});

	it('passes on any other failure in the server’s words', async () => {
		fail({ kind: 'rejected', status: 500, body: '{"error":{"message":"boom"}}' });
		const p = await probeUpscaler('image', entry());
		expect(p.ok).toBe(false);
		expect(p.detail).toContain('boom');
		expect(p.models).toEqual([]);
	});

	it('says the server has no upscalers of the kind', async () => {
		serve({ object: 'list', data: [] });
		expect(await probeUpscaler('video', entry())).toEqual({
			ok: false,
			detail: 'gpu.lan:3000 has no video upscalers. Add one in llama-toolchest.',
			models: []
		});
		serve(vupscale);
		expect((await probeUpscaler('image', entry())).detail).toBe(
			'gpu.lan:3000 has no picture upscalers. Add one in llama-toolchest.'
		);
	});

	it('asks for a pick, and names a pick the server lacks', async () => {
		serve(images);
		const none = await probeUpscaler('image', entry({ model: '' }));
		expect(none).toMatchObject({ ok: false, detail: 'Pick an upscaler.' });
		expect(none.models).toHaveLength(3);
		const gone = await probeUpscaler('image', entry({ model: 'no-route' }));
		expect(gone).toMatchObject({
			ok: false,
			detail: 'gpu.lan:3000 has no upscaler called no-route.'
		});
	});

	it('refuses an upscaler that can make nothing, and saves nothing', async () => {
		serve(images);
		const p = await probeUpscaler('image', entry({ model: 'broken' }));
		expect(p).toMatchObject({
			ok: false,
			detail: 'broken is failed — check it in llama-toolchest.'
		});
		expect(p.caps).toBeUndefined();
		expect(settings.imageUpscalers[0].caps).toBeNull();
	});
});

describe('readyUpscaler', () => {
	it('answers the upscaler, its server and key, and saves its caps', async () => {
		serve(images);
		const r = await readyUpscaler('image', entry({ keyId: 'k1', url: ' http://gpu.lan:3000 ' }));
		expect(r.cfg).toEqual({ baseUrl: 'http://gpu.lan:3000', apiKey: 'sekrit' });
		expect(r.instance).toMatchObject({ id: 'esrgan-x4', state: 'running' });
		expect(r.caps).toEqual({ scale: 4, limits: null });
		expect(settings.imageUpscalers[0].caps).toEqual({ scale: 4, limits: null });
	});

	it('takes a stopped upscaler: toolchest starts it', async () => {
		serve(vupscale);
		const r = await readyUpscaler('video', entry({ model: 'relayvsr-x4' }));
		expect(r.caps).toMatchObject({ scale: 4, limits: { measuredWidth: 512 } });
	});

	it('names the section when there is no server or no pick', async () => {
		const noServer = await refusal(readyUpscaler('video', entry({ url: '' })));
		expect(noServer).toMatchObject({ kind: 'unconfigured' });
		expect(noServer.message).toBe(
			'Upscaler has no server — Settings → Video generation → Upscalers.'
		);
		const noPick = await refusal(readyUpscaler('image', entry({ model: ' ' })));
		expect(noPick.message).toBe(
			'Upscaler has no upscaler picked — Settings → Image generation → Upscalers.'
		);
	});

	it('says the upscaler is gone, or can make nothing', async () => {
		serve(images);
		const gone = await refusal(readyUpscaler('image', entry({ model: 'nope' })));
		expect(gone).toMatchObject({
			kind: 'unconfigured',
			message: 'nope is not on gpu.lan:3000 any more.'
		});
		const broken = await refusal(readyUpscaler('image', entry({ model: 'broken' })));
		expect(broken).toMatchObject({
			kind: 'unconfigured',
			message: 'broken is failed — check it in llama-toolchest.'
		});
		serve({ data: [] });
		expect((await refusal(readyUpscaler('image', entry()))).message).toContain('any more');
	});

	it('passes a failed request on as the client’s error', async () => {
		fail({ kind: 'unreachable', message: 'connection refused' });
		expect(await refusal(readyUpscaler('image', entry()))).toMatchObject({
			kind: 'unreachable'
		});
		fail({ kind: 'rejected', status: 401, body: '' });
		expect(await refusal(readyUpscaler('image', entry()))).toMatchObject({
			kind: 'rejected',
			status: 401
		});
	});

	it('stops at once when already aborted', async () => {
		serve(images);
		const ac = new AbortController();
		ac.abort();
		expect(await refusal(readyUpscaler('image', entry(), ac.signal))).toMatchObject({
			kind: 'cancelled'
		});
	});
});
