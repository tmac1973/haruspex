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
import { lemonadeBackend, TRANSPARENCY_LOST } from './backend';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { ImageProgress } from '#lib/image/types.ts';

const catalogue = [
	{
		id: 'ming',
		name: 'user.Ming-Image-0.1-Design-GGUF',
		description: 'Ming-Image 0.1 Design — transparent sprites, the default (~17 GB)'
	},
	{
		id: 'qwen21',
		name: 'user.Qwen-Image-2.1-Turbo-GGUF',
		description: 'Qwen-Image 2.1 Turbo — transparent by prompt, non-commercial (~10 GB)'
	}
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

	it('probes a real server’s answers into one sentence and the Model list', async () => {
		expect(await lemonadeBackend.probe()).toEqual({
			ok: true,
			detail: 'Connected — Lemonade 2026.43.3 on AMD Radeon AI PRO R9700 (gfx1201), rocm.',
			// Only what is installed there: the dropdown chooses among these.
			models: [{ name: 'ming', label: 'Ming-Image 0.1 Design' }]
		});
	});

	it('lists the models even when the chosen one is missing or none is chosen', async () => {
		settings.imageLemonadeModelId = 'qwen21';
		const missing = await lemonadeBackend.probe();
		expect(missing.detail).toMatch(/Qwen-Image 2.1 Turbo is not installed on the server/);
		expect(missing.models).toEqual([{ name: 'ming', label: 'Ming-Image 0.1 Design' }]);
		settings.imageLemonadeModelId = '';
		const none = await lemonadeBackend.probe();
		expect(none.detail).toMatch(/No model is chosen/);
		expect(none.models).toHaveLength(1);
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

	it('says so when a transparent Ming request comes back with no transparency', async () => {
		const plain = tauri.invoke.getMockImplementation()!;
		const answer = (clear: number) =>
			tauri.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
				cmd === 'image_transparent_fraction' ? clear : plain(cmd, args)
			);
		const coin = { prompt: 'a coin', width: 1024, height: 1024, seed: 5, transparent: true };
		answer(0);
		expect((await lemonadeBackend.generate(coin)).meta.transparencyFailed).toBe(TRANSPARENCY_LOST);
		answer(0.42);
		expect((await lemonadeBackend.generate(coin)).meta.transparencyFailed).toBeUndefined();
		// Not asked for transparency, so not checked.
		answer(0);
		const opaque = await lemonadeBackend.generate({ ...coin, transparent: false });
		expect(opaque.meta.transparencyFailed).toBeUndefined();
		const checks = tauri.invoke.mock.calls.filter(([c]) => c === 'image_transparent_fraction');
		expect(checks).toHaveLength(2);
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

describe('lemonade edits and upscaling', () => {
	/** The recorded model list, with Qwen installed with its vision weights and the upscaler. */
	const withEditing = {
		data: [
			...(models as { data: unknown[] }).data,
			{
				id: 'user.Qwen-Image-2.1-Turbo-GGUF',
				downloaded: true,
				checkpoints: { main: 'q:main.gguf', llm_vision: 'q:mmproj.gguf' }
			},
			{ id: 'RealESRGAN-x4plus', downloaded: true, checkpoints: { main: 'amd/r:x.pth' } }
		]
	};
	const use = (list: unknown) =>
		tauri.invoke.mockReset().mockImplementation(
			invokeRouter({
				lemonade_catalogue: catalogue,
				image_read_bytes: () => new Uint8Array([1, 2, 3]).buffer,
				lemonade_upload: () => ({ data: [{ b64_json: 'BAUG' }] }),
				lemonade_json: route({
					'/api/v1/health': health,
					'/api/v1/system-info': systemInfo,
					'/api/v1/models?show_all=true': list,
					'/api/v1/images/upscale': { data: [{ b64_json: 'BwgJ' }] }
				})
			})
		);
	const edit = {
		prompt: 'make it night',
		width: 1024,
		height: 768,
		seed: 3,
		edit: { images: [{ name: 'car.png', hash: 'a'.repeat(64) }] }
	};

	it('says Qwen can edit only with its vision weights, and upscales once the upscaler is in', async () => {
		settings.imageLemonadeModelId = 'qwen21';
		use(withEditing);
		expect(await lemonadeBackend.capabilities()).toMatchObject({
			edit: true,
			maxEditImages: 3,
			upscale: true
		});
		use(models);
		expect(await lemonadeBackend.capabilities()).toMatchObject({ edit: false, upscale: false });
	});

	it('edits through /api/v1/images/edits, the picture a file part from the cache', async () => {
		settings.imageLemonadeModelId = 'qwen21';
		use(withEditing);
		const r = await lemonadeBackend.generate(edit);
		expect(Array.from(r.images[0].bytes)).toEqual([4, 5, 6]);
		const [, args] = tauri.invoke.mock.calls.find(([c]) => c === 'lemonade_upload')!;
		expect(args.call.path).toBe('/api/v1/images/edits');
		expect(args.call.body).toMatchObject({
			model: 'user.Qwen-Image-2.1-Turbo-GGUF',
			size: '1024x768',
			n: '1'
		});
		expect(String(args.call.body.prompt)).toMatch(
			/^<sd_cpp_extra_args>\{"seed":3,.*<\/sd_cpp_extra_args> make it night$/
		);
		expect(args.files).toEqual([
			{ field: 'image[]', filename: 'car.png', hash: 'a'.repeat(64), cache: 'image', bytes: null }
		]);
	});

	it('sends an edit’s mask as the form’s mask part', async () => {
		settings.imageLemonadeModelId = 'qwen21';
		use(withEditing);
		const mask = { name: 'mask.png', hash: 'b'.repeat(64) };
		await lemonadeBackend.generate({ ...edit, edit: { ...edit.edit!, mask } });
		const [, args] = tauri.invoke.mock.calls.findLast(([c]) => c === 'lemonade_upload')!;
		expect(args.files.map((f: { field: string }) => f.field)).toEqual(['image[]', 'mask']);
		expect(args.files[1]).toMatchObject({ hash: 'b'.repeat(64), cache: 'image' });
	});

	it('refuses an edit without the vision weights, pointing at Add editing', async () => {
		settings.imageLemonadeModelId = 'qwen21';
		use(models);
		await expect(lemonadeBackend.generate(edit)).rejects.toMatchObject({
			kind: 'unconfigured',
			message: expect.stringContaining('Add editing')
		});
	});

	it('upscales with Lemonade’s Real-ESRGAN, sending the cached picture', async () => {
		use(withEditing);
		const out = await lemonadeBackend.upscale!({ name: 'a.png', hash: 'a'.repeat(64) });
		expect(Array.from(out)).toEqual([7, 8, 9]);
		const call = tauri.invoke.mock.calls.find(
			([c, a]) => c === 'lemonade_json' && a.call.path === '/api/v1/images/upscale'
		)!;
		expect(call[1].call.body).toEqual({ model: 'RealESRGAN-x4plus', image: 'AQID' });
	});
});
