import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
const settings = vi.hoisted(() => ({
	imageModels: [] as ImageModelEntry[],
	inferenceBackend: {
		remoteBackendKind: 'llama-toolchest',
		remoteApiKeyId: 'tc',
		remoteProfiles: {} as Record<string, { remoteApiKeyId: string | null }>
	}
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, { settings })
);
vi.mock('#lib/toolchest/models.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	toolchestKeyFor: async (id: string | null) => (id === 'or' ? 'sk-or-test' : '')
}));

import { invoke } from '@tauri-apps/api/core';
import { invokeArgs, invokeRouter } from '#lib/testing/invoke.ts';
import { imageModel } from '#lib/testing/imageModels.ts';
import { backendForEntry } from '#lib/image/index.ts';
import type { ImageBackend } from '#lib/image/backend.ts';
import { ImageBackendError, type ImageModelEntry } from '#lib/image/types.ts';
import { TRANSPARENCY_LOST, _resetForTests, inferenceOpenRouterKeyId } from './backend';
import { generationSpend, _resetForTests as resetSpend } from '#lib/generation/spend.svelte.ts';

const LIST = {
	data: [
		{
			id: 'openai/gpt-image-2',
			name: 'OpenAI: GPT Image 2',
			supported_parameters: {
				aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
				output_format: { type: 'enum', values: ['png', 'jpeg'] },
				background: { type: 'enum', values: ['auto', 'transparent', 'opaque'] },
				input_references: { type: 'range', min: 0, max: 16 }
			}
		},
		{
			id: 'qwen/qwen-image-2.1-turbo',
			name: 'Qwen: Qwen Image 2.1 Turbo',
			supported_parameters: { seed: { type: 'boolean' } }
		}
	]
};

const ENDPOINTS = {
	endpoints: [{ pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }] }]
};

/** A base64 PNG signature: what the server "drew". */
const DRAWN = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));

interface Sent {
	url: string;
	init: RequestInit;
}
let sent: Sent[];
let answer: (url: string, init: RequestInit) => Response | Promise<Response>;

const json = (v: unknown, status = 200) =>
	new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

function defaultAnswer(url: string): Response {
	if (url.endsWith('/v1/images/models')) return json(LIST);
	if (url.includes('/endpoints')) return json(ENDPOINTS);
	if (url.endsWith('/v1/key')) return json({ data: { label: 'k', limit: null, usage: 0 } });
	if (url.endsWith('/v1/images'))
		return json({ data: [{ b64_json: DRAWN }], usage: { cost: 0.04 } });
	return json({ error: { message: 'no route' } }, 404);
}

function entry(over: Partial<ImageModelEntry> = {}): ImageModelEntry {
	return imageModel('openrouter', { keyId: 'or', model: 'openai/gpt-image-2', ...over });
}

function backend(over: Partial<ImageModelEntry> = {}): ImageBackend {
	const e = entry(over);
	settings.imageModels = [e];
	return backendForEntry(e)!;
}

const request = { prompt: 'a red apple', width: 512, height: 288, seed: 7 };

/** The JSON body of the generation request. */
const generationBody = () =>
	JSON.parse(sent.find((s) => s.url.endsWith('/v1/images'))!.init.body as string);

beforeEach(() => {
	_resetForTests();
	sent = [];
	answer = defaultAnswer;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit = {}) => {
			sent.push({ url, init });
			return answer(url, init);
		})
	);
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			image_fit_cover: [1, 2, 3],
			image_transparent_fraction: 0.4,
			image_read_bytes: () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('OpenRouter image backend', () => {
	it('draws one picture, fitted to the size asked for', async () => {
		const result = await backend().generate(request);
		expect(generationBody()).toEqual({
			model: 'openai/gpt-image-2',
			prompt: 'a red apple',
			response_format: 'b64_json',
			aspect_ratio: '16:9',
			output_format: 'png'
		});
		const call = sent.find((s) => s.url.endsWith('/v1/images'))!;
		expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
		expect(invokeArgs(vi.mocked(invoke), 'image_fit_cover')).toMatchObject({
			width: 512,
			height: 288
		});
		expect(result.images).toEqual([
			{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', width: 512, height: 288 }
		]);
		expect(result.meta).toMatchObject({
			backend: 'openrouter',
			model: 'openai/gpt-image-2',
			seed: 7,
			entryId: 'test-openrouter',
			costUsd: 0.04
		});
	});

	it('counts what the picture cost, and one that came with no price', async () => {
		localStorage.clear();
		resetSpend();
		await backend().generate(request);
		expect(generationSpend()).toMatchObject({ usd: 0.04, pictures: 1, clips: 0, unpriced: 0 });
		answer = (url) =>
			url.endsWith('/v1/images') ? json({ data: [{ b64_json: DRAWN }] }) : defaultAnswer(url);
		const result = await backend().generate(request);
		expect(result.meta.costUsd).toBeUndefined();
		expect(generationSpend()).toMatchObject({ usd: 0.04, pictures: 2, unpriced: 1 });
	});

	it('sends the seed to a model that takes one', async () => {
		await backend({ model: 'qwen/qwen-image-2.1-turbo' }).generate({
			...request,
			seed: 2 ** 31 + 5
		});
		expect(generationBody().seed).toBe(5);
	});

	it('asks for a transparent background, and says so when it came back solid', async () => {
		const b = backend();
		const clear = await b.generate({ ...request, transparent: true });
		expect(generationBody().background).toBe('transparent');
		expect(clear.meta.transparencyFailed).toBeUndefined();

		vi.mocked(invoke).mockImplementation(
			invokeRouter({ image_fit_cover: [1], image_transparent_fraction: 0 })
		);
		const solid = await b.generate({ ...request, transparent: true });
		expect(solid.meta.transparencyFailed).toBe(TRANSPARENCY_LOST);
	});

	it('sends pictures to edit as data URLs', async () => {
		await backend().generate({
			...request,
			edit: {
				images: [
					{ name: 'a.jpg', hash: 'abc' },
					{ name: 'b.png', bytes: [0x89, 0x50] }
				]
			}
		});
		const refs = generationBody().input_references.map(
			(r: { image_url: { url: string } }) => r.image_url.url
		);
		expect(refs[0]).toMatch(/^data:image\/jpeg;base64,/);
		expect(refs[1]).toMatch(/^data:image\/png;base64,/);
	});

	it('refuses a mask and an extend, before anything is paid for', async () => {
		const b = backend();
		await expect(
			b.generate({
				...request,
				edit: { images: [{ name: 'a', hash: 'a' }], mask: { name: 'm', hash: 'm' } }
			})
		).rejects.toMatchObject({ kind: 'unconfigured' });
		await expect(
			b.generate({
				...request,
				inpaint: { image: { name: 'a', hash: 'a' }, mask: { name: 'm', hash: 'm' } }
			})
		).rejects.toMatchObject({ kind: 'unconfigured' });
		expect(sent.some((s) => s.url.endsWith('/v1/images'))).toBe(false);
	});

	it('says the edges may not wrap for a tiling request', async () => {
		const result = await backend().generate({ ...request, seamless: true });
		expect(result.meta.seamFailed).toMatch(/tiling/);
	});

	it('needs a key and a model', async () => {
		await expect(backend({ keyId: null }).generate(request)).rejects.toMatchObject({
			kind: 'unconfigured'
		});
		await expect(backend({ model: '' }).generate(request)).rejects.toMatchObject({
			kind: 'unconfigured'
		});
		await expect(backend({ model: 'gone/model' }).generate(request)).rejects.toThrow(
			/no longer lists gone\/model/
		);
	});

	it('maps refusals: a bad key is unconfigured, a 5xx or 429 transient, a 404 passed over, a 400 rejected', async () => {
		const cases: Array<[number, ImageBackendError['kind']]> = [
			[401, 'unconfigured'],
			[402, 'rejected'],
			[400, 'rejected'],
			// "No endpoint found for model": try the next model.
			[404, 'unconfigured'],
			[429, 'unreachable'],
			[502, 'unreachable']
		];
		for (const [status, kind] of cases) {
			answer = (url) =>
				url.endsWith('/v1/images')
					? json({ error: { message: `said ${status}` } }, status)
					: defaultAnswer(url);
			const err = await backend()
				.generate(request)
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(ImageBackendError);
			expect(err).toMatchObject({ kind, status });
			expect((err as Error).message).toContain(`said ${status}`);
		}
	});

	it('is cancelled with its signal', async () => {
		answer = (url, init) =>
			url.endsWith('/v1/images')
				? new Promise((_, reject) =>
						init.signal!.addEventListener('abort', () =>
							reject(new DOMException('aborted', 'AbortError'))
						)
					)
				: defaultAnswer(url);
		const ctrl = new AbortController();
		const run = backend().generate(request, { signal: ctrl.signal });
		await vi.waitFor(() => expect(sent.some((s) => s.url.endsWith('/v1/images'))).toBe(true));
		ctrl.abort();
		await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
	});

	it('is unreachable when the network fails', async () => {
		answer = () => {
			throw new TypeError('Failed to fetch');
		};
		await expect(backend().generate(request)).rejects.toMatchObject({ kind: 'unreachable' });
	});

	it('reports no picture as a rejection', async () => {
		answer = (url) => (url.endsWith('/v1/images') ? json({ data: [] }) : defaultAnswer(url));
		await expect(backend().generate(request)).rejects.toThrow(/no picture/);
	});
});

describe('probe and capabilities', () => {
	it('lists the models, checks the key and says the price', async () => {
		const result = await backend().probe();
		expect(result.ok).toBe(true);
		expect(result.detail).toBe('Connected — $0.04 a picture.');
		expect(result.models?.map((m) => m.name)).toEqual([
			'openai/gpt-image-2',
			'qwen/qwen-image-2.1-turbo'
		]);
		const key = sent.find((s) => s.url.endsWith('/v1/key'))!;
		expect((key.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
	});

	it('lists the models even without a key or a model', async () => {
		const noKey = await backend({ keyId: null }).probe();
		expect(noKey).toMatchObject({ ok: false, detail: 'Choose an OpenRouter API key.' });
		expect(noKey.models).toHaveLength(2);
		const noModel = await backend({ model: '' }).probe();
		expect(noModel).toMatchObject({ ok: false, detail: 'Choose a model.' });
	});

	it('says what a refused key said', async () => {
		answer = (url) =>
			url.endsWith('/v1/key') ? json({ error: { message: 'bad key' } }, 401) : defaultAnswer(url);
		const result = await backend().probe();
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(/401/);
	});

	it("reads the model's capabilities from the list, asked once", async () => {
		const b = backend();
		expect(await b.capabilities()).toMatchObject({
			transparency: true,
			edit: true,
			maxEditImages: 16,
			upscale: false
		});
		await b.capabilities();
		expect(sent.filter((s) => s.url.endsWith('/v1/images/models'))).toHaveLength(1);
	});
});

describe('inferenceOpenRouterKeyId', () => {
	it("is the inference key when OpenRouter is the remote option, else its saved profile's", () => {
		settings.inferenceBackend = {
			remoteBackendKind: 'openrouter',
			remoteApiKeyId: 'or',
			remoteProfiles: {}
		};
		expect(inferenceOpenRouterKeyId()).toBe('or');
		settings.inferenceBackend = {
			remoteBackendKind: 'llama-toolchest',
			remoteApiKeyId: 'tc',
			remoteProfiles: { openrouter: { remoteApiKeyId: 'saved' } }
		};
		expect(inferenceOpenRouterKeyId()).toBe('saved');
		settings.inferenceBackend = {
			remoteBackendKind: 'llama-toolchest',
			remoteApiKeyId: 'tc',
			remoteProfiles: {}
		};
		expect(inferenceOpenRouterKeyId()).toBeNull();
	});
});
