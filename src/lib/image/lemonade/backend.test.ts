import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
const settings = vi.hoisted(() => ({
	imageLemonadeBaseUrl: 'http://box:13305',
	imageLemonadeApiKey: '',
	imageLemonadeModelId: 'ming'
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => settings
}));

import health from './fixtures/health.json';
import systemInfo from './fixtures/system-info.json';
import models from './fixtures/models.json';
import { lemonadeBackend } from './backend';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { ImageProgress } from '#lib/image/types.ts';

const catalogue = [
	{ id: 'ming', name: 'user.Ming-Image-0.1-Design-GGUF' },
	{ id: 'qwen21', name: 'user.Qwen-Image-2.1-Turbo-GGUF' }
];

interface Call {
	method: string;
	path: string;
	body: Record<string, unknown> | null;
	timeout_ms: number;
}

function route(answers: Record<string, unknown>) {
	return (args?: Record<string, unknown>) => {
		const call = args!.call as Call;
		const a = answers[call.path];
		if (a === undefined) throw { kind: 'rejected', status: 404, body: '{}' };
		return typeof a === 'function' ? a(call) : a;
	};
}

const generations = () =>
	tauri.invoke.mock.calls
		.filter(([c, a]) => c === 'lemonade_json' && a.call.path === '/api/v1/images/generations')
		.map(([, a]) => a.call as Call);

/** The native parameters a generation carried, from its leading block. */
const extrasOf = (call: Call) =>
	JSON.parse(/^<sd_cpp_extra_args>(.*?)<\/sd_cpp_extra_args>/.exec(String(call.body!.prompt))![1]);

describe('lemonade backend', () => {
	beforeEach(() => {
		settings.imageLemonadeBaseUrl = 'http://box:13305';
		settings.imageLemonadeModelId = 'ming';
		tauri.invoke.mockReset().mockImplementation(
			invokeRouter({
				lemonade_catalogue: catalogue,
				image_clear_canvas: [1, 2, 3],
				image_seam_inputs: { rolled: [4, 5, 6], mask: [7, 8, 9] },
				image_seam_finish: [9, 9, 9],
				lemonade_json: route({
					'/api/v1/health': health,
					'/api/v1/system-info': systemInfo,
					'/api/v1/models?show_all=true': models,
					'/api/v1/images/generations': { data: [{ b64_json: 'AQID' }] }
				})
			})
		);
	});

	it('probes a real server’s answers into one sentence', async () => {
		expect(await lemonadeBackend.probe()).toEqual({
			ok: true,
			detail: 'Lemonade 2026.43.3 on AMD Radeon AI PRO R9700 (gfx1201), rocm.'
		});
	});

	it('says what is missing before it says anything else', async () => {
		settings.imageLemonadeModelId = 'qwen21';
		expect((await lemonadeBackend.probe()).detail).toMatch(/not installed — Settings → Image/);
		settings.imageLemonadeModelId = '';
		expect((await lemonadeBackend.probe()).detail).toMatch(/No model is chosen/);
		settings.imageLemonadeBaseUrl = '';
		expect(await lemonadeBackend.probe()).toEqual({
			ok: false,
			detail: 'No server address — Settings → Image.'
		});
	});

	it('makes Ming transparent from a clear canvas AND its RGBA phrase', async () => {
		const r = await lemonadeBackend.generate({
			prompt: 'a coin',
			width: 1024,
			height: 1024,
			seed: 5,
			transparent: true
		});
		const [call] = generations();
		expect(call.body).toMatchObject({ model: 'user.Ming-Image-0.1-Design-GGUF', seed: 5 });
		expect(String(call.body!.prompt)).toMatch(
			/<\/sd_cpp_extra_args> RGBA, 4-channel, transparent background\. a coin$/
		);
		expect(extrasOf(call)).toMatchObject({
			seed: 5,
			init_image: 'AQID',
			strength: 0.9,
			sample_params: { sample_steps: 12 }
		});
		expect(r.images[0].bytes).toEqual(new Uint8Array([1, 2, 3]));
		expect(r.meta).toMatchObject({ seed: 5, model: 'ming', backend: 'lemonade' });
	});

	it('pins a seed when the request has none, so the recipe records a real one', async () => {
		const r = await lemonadeBackend.generate({ prompt: 'x', width: 64, height: 64, seed: null });
		const [call] = generations();
		expect(Number.isInteger(r.meta.seed) && r.meta.seed >= 0).toBe(true);
		expect(extrasOf(call).seed).toBe(r.meta.seed);
	});

	it('makes Qwen transparent by prompt alone, from noise', async () => {
		settings.imageLemonadeModelId = 'qwen21';
		await lemonadeBackend.generate({
			prompt: 'a coin',
			width: 512,
			height: 512,
			seed: 1,
			transparent: true
		});
		const [call] = generations();
		expect(String(call.body!.prompt)).toMatch(/This is an RGBA format image/);
		expect(extrasOf(call)).not.toHaveProperty('init_image');
		expect(extrasOf(call).sample_params.sample_steps).toBe(8);
	});

	it('does not claim to tile, and says so when asked to', async () => {
		expect(await lemonadeBackend.capabilities()).toMatchObject({
			transparency: true,
			seamlessTiling: false
		});
		const r = await lemonadeBackend.generate({
			prompt: 'cobbles',
			width: 1024,
			height: 1024,
			seed: 3,
			seamless: true,
			transparent: true
		});
		// One opaque draw: no seam pass, whose start image would crash sd-server.
		expect(generations()).toHaveLength(1);
		expect(extrasOf(generations()[0])).not.toHaveProperty('init_image');
		expect(tauri.invoke).not.toHaveBeenCalledWith('image_seam_inputs', expect.anything());
		expect(r.meta.seamFailed).toMatch(/cannot make tiling textures/);
	});

	it('says it is loading when another image model is resident', async () => {
		settings.imageLemonadeModelId = 'qwen21';
		const seen: ImageProgress[] = [];
		await lemonadeBackend.generate(
			{ prompt: 'x', width: 64, height: 64, seed: 1 },
			{ onProgress: (p) => seen.push(p) }
		);
		expect(seen[0].phase).toBe('loading');
	});

	it('refuses to start without a server or a model', async () => {
		settings.imageLemonadeModelId = '';
		await expect(
			lemonadeBackend.generate({ prompt: 'x', width: 64, height: 64, seed: 1 })
		).rejects.toMatchObject({ kind: 'unconfigured' });
		settings.imageLemonadeBaseUrl = '';
		await expect(
			lemonadeBackend.generate({ prompt: 'x', width: 64, height: 64, seed: 1 })
		).rejects.toMatchObject({ kind: 'unconfigured' });
	});

	it('passes Lemonade’s own refusal on in words', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				lemonade_catalogue: catalogue,
				lemonade_json: route({
					'/api/v1/health': health,
					'/api/v1/system-info': systemInfo,
					'/api/v1/models?show_all=true': models,
					'/api/v1/images/generations': () => {
						throw {
							kind: 'rejected',
							status: 404,
							body: '{"error":{"message":"Model \'user.Ming-Image-0.1-Design-GGUF\' was not found."}}'
						};
					}
				})
			})
		);
		await expect(
			lemonadeBackend.generate({ prompt: 'x', width: 64, height: 64, seed: 1 })
		).rejects.toMatchObject({
			kind: 'rejected',
			message:
				"Lemonade refused /api/v1/images/generations: Model 'user.Ming-Image-0.1-Design-GGUF' was not found."
		});
	});
});
