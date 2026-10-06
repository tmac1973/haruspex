import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
const settings = vi.hoisted(() => ({ imageLocalModelId: 'ming' }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => settings
}));

import { engineSetupMessage, localBackend } from './backend';

describe('engineSetupMessage', () => {
	it('says what is missing and what to do, not just a fragment', () => {
		// The Rust detail for a missing engine is "sd-server"; that alone was
		// what the user saw.
		expect(engineSetupMessage('SidecarMissing', 'sd-server')).toBe(
			'The bundled image engine is missing (sd-server). Reinstall Haruspex, or in a ' +
				'development checkout run ./scripts/fetch-sdcpp.sh.'
		);
		expect(engineSetupMessage('ModelMissing', '/m/sd15.safetensors')).toMatch(
			/not on disk \(\/m\/sd15\.safetensors\) — download it again in Settings → Image/
		);
		expect(engineSetupMessage('NoModel', '')).toMatch(/Settings → Image/);
	});

	it('leaves the failures that are not set-up to the caller', () => {
		expect(engineSetupMessage('Timeout', 'no answer')).toBeNull();
		expect(engineSetupMessage(undefined, 'boom')).toBeNull();
	});
});

describe('generate', () => {
	beforeEach(() => {
		tauri.invoke
			.mockReset()
			.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
				if (cmd === 'image_clear_canvas') return [1, 2, 3];
				if (cmd === 'image_seam_inputs') return { rolled: [4, 5, 6], mask: [7, 8, 9] };
				if (cmd === 'image_seam_finish') return [9, 9, 9];
				if (cmd === 'image_engine_request') {
					return JSON.stringify({ images: ['AQID'], info: JSON.stringify({ seed: 5 }), args });
				}
				return undefined;
			});
	});
	const sent = () => {
		const call = tauri.invoke.mock.calls.find(([c]) => c === 'image_engine_request')!;
		return { path: call[1].path as string, body: JSON.parse(call[1].body as string) };
	};

	it('starts the engine on the catalogue id, not a file path', async () => {
		settings.imageLocalModelId = 'ming';
		await localBackend.generate({ prompt: 'a coin', width: 64, height: 64, seed: 1 });
		expect(tauri.invoke).toHaveBeenCalledWith('image_engine_start', { modelId: 'ming' });
	});

	it('makes Ming transparent from a clear canvas AND its RGBA phrase', async () => {
		settings.imageLocalModelId = 'ming';
		const r = await localBackend.generate({
			prompt: 'a coin',
			width: 1024,
			height: 1024,
			seed: 1,
			transparent: true
		});
		expect(tauri.invoke).toHaveBeenCalledWith('image_clear_canvas', { width: 1024, height: 1024 });
		const { path, body } = sent();
		expect(path).toBe('/sdapi/v1/img2img');
		expect(body.init_images).toEqual(['AQID']);
		expect(body.prompt).toMatch(/^RGBA, 4-channel, transparent background\. a coin/);
		expect(body).toMatchObject({ steps: 12, cfg_scale: 1 });
		expect(r.meta).toMatchObject({ seed: 5, model: 'ming', backend: 'local' });
	});

	it('makes Qwen transparent by prompt alone, from noise', async () => {
		settings.imageLocalModelId = 'qwen21';
		await localBackend.generate({
			prompt: 'a coin',
			width: 512,
			height: 512,
			seed: 1,
			transparent: true
		});
		const { path, body } = sent();
		expect(path).toBe('/sdapi/v1/txt2img');
		expect(body.init_images).toBeUndefined();
		expect(body.prompt).toMatch(/^This is an RGBA format image with transparency\. a coin/);
		expect(body.steps).toBe(25);
		expect(tauri.invoke).not.toHaveBeenCalledWith('image_clear_canvas', expect.anything());
	});

	it('tiles by rolling, repainting the seams through the mask, and blending back', async () => {
		settings.imageLocalModelId = 'ming';
		const r = await localBackend.generate({
			prompt: 'cobblestones',
			width: 1024,
			height: 1024,
			seed: 1,
			seamless: true
		});
		const calls = tauri.invoke.mock.calls.filter(([c]) => c === 'image_engine_request');
		expect(calls.map(([, a]) => a.path)).toEqual(['/sdapi/v1/txt2img', '/sdapi/v1/img2img']);
		const repaint = JSON.parse(calls[1][1].body as string);
		expect(repaint).toMatchObject({
			init_images: ['BAUG'],
			mask: 'BwgJ',
			denoising_strength: 0.75,
			prompt: 'cobblestones'
		});
		// A seed of its own: the base's would redraw the base's layout.
		expect(repaint.seed).toBe(6);
		expect(tauri.invoke).toHaveBeenCalledWith('image_seam_inputs', { bytes: [1, 2, 3] });
		expect(tauri.invoke).toHaveBeenCalledWith('image_seam_finish', {
			rolled: [4, 5, 6],
			repainted: [1, 2, 3]
		});
		expect(Array.from(r.images[0].bytes)).toEqual([9, 9, 9]);
		expect(r.meta.seed).toBe(5);
	});

	it('returns the texture it drew, untiled and saying why, when the seam pass fails', async () => {
		settings.imageLocalModelId = 'qwen21';
		const base = tauri.invoke.getMockImplementation()!;
		tauri.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'image_engine_request' && String(args?.path).endsWith('img2img')) {
				throw new Error('500 {"error":"generate_image returned no results"}');
			}
			return base(cmd, args);
		});
		const r = await localBackend.generate({
			prompt: 'grass',
			width: 1024,
			height: 1024,
			seed: 1,
			seamless: true
		});
		expect(Array.from(r.images[0].bytes)).toEqual([1, 2, 3]);
		expect(r.meta.seamFailed).toMatch(/generate_image returned no results/);
	});

	it('draws a tiling texture opaque even when asked for transparency too', async () => {
		settings.imageLocalModelId = 'ming';
		await localBackend.generate({
			prompt: 'grass',
			width: 512,
			height: 512,
			seed: 1,
			seamless: true,
			transparent: true
		});
		expect(tauri.invoke).not.toHaveBeenCalledWith('image_clear_canvas', expect.anything());
		expect(sent().body.prompt).toBe('grass');
	});

	it("retries the engine's transient empty result, and gives up after three", async () => {
		settings.imageLocalModelId = 'ming';
		vi.useFakeTimers();
		try {
			const empty = new Error(
				'The image engine refused /sdapi/v1/img2img (500 Internal Server Error): ' +
					'{"error":"generate_image returned no results"}'
			);
			const base = tauri.invoke.getMockImplementation()!;
			let fails = 2;
			tauri.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
				if (cmd === 'image_engine_request' && fails-- > 0) throw empty;
				return base(cmd, args);
			});
			const ok = localBackend.generate({ prompt: 'a coin', width: 64, height: 64, seed: 1 });
			await vi.runAllTimersAsync();
			await expect(ok).resolves.toBeTruthy();

			fails = 3;
			const failed = localBackend.generate({ prompt: 'a coin', width: 64, height: 64, seed: 1 });
			const settled = expect(failed).rejects.toThrow(/generate_image returned no results/);
			await vi.runAllTimersAsync();
			await settled;
			expect(tauri.invoke.mock.calls.filter(([c]) => c === 'image_engine_request').length).toBe(6);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not retry other engine failures', async () => {
		settings.imageLocalModelId = 'ming';
		const base = tauri.invoke.getMockImplementation()!;
		tauri.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'image_engine_request') throw new Error('connection refused');
			return base(cmd, args);
		});
		await expect(
			localBackend.generate({ prompt: 'a coin', width: 64, height: 64, seed: 1 })
		).rejects.toThrow(/connection refused/);
		expect(tauri.invoke.mock.calls.filter(([c]) => c === 'image_engine_request').length).toBe(1);
	});

	it('refuses an id it cannot run, before starting anything', async () => {
		settings.imageLocalModelId = 'sdxl';
		await expect(
			localBackend.generate({ prompt: 'a coin', width: 64, height: 64, seed: 1 })
		).rejects.toMatchObject({ kind: 'unconfigured' });
		expect(tauri.invoke).not.toHaveBeenCalledWith('image_engine_start', expect.anything());
	});
});
