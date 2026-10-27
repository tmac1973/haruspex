import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import { comfyUiBackend } from './backend';
import { upscaleGraph } from './upscale';
import { findUpscaler } from './families';

const saved = {
	url: getSettings().imageBackendBaseUrl,
	ckpt: getSettings().imageComfyCheckpoint
};

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let fetchMock: ReturnType<typeof vi.fn>;

/** A server whose `models/upscale_models` holds `upscalers`. */
function server(upscalers: string[]) {
	fetchMock.mockImplementation(async (url: string) => {
		const body = (b: unknown) =>
			({
				ok: true,
				status: 200,
				json: async () => b,
				text: async () => JSON.stringify(b),
				arrayBuffer: async () => PNG.buffer
			}) as Response;
		if (url.includes('/upload/image')) return body({ name: 'up.png', subfolder: '' });
		if (url.includes('/prompt')) return body({ prompt_id: 'p1' });
		if (url.includes('/history'))
			return body({
				p1: { outputs: { '4': { images: [{ filename: 'u.png', subfolder: '', type: 'output' }] } } }
			});
		// ComfyUI 0.39's shape for this node: ["COMBO", {options}].
		if (url.includes('/object_info/UpscaleModelLoader'))
			return body({
				UpscaleModelLoader: {
					input: { required: { model_name: ['COMBO', { multiselect: false, options: upscalers }] } }
				}
			});
		return body({});
	});
}

function submitted() {
	const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/prompt'))!;
	return JSON.parse((call[1] as RequestInit).body as string).prompt;
}

beforeEach(() => {
	updateSettings({
		imageBackendBaseUrl: 'http://box:8188',
		imageComfyCheckpoint: 'sd15.safetensors'
	});
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal(
		'WebSocket',
		class {
			constructor(readonly url: string) {}
			close() {}
		}
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	updateSettings({ imageBackendBaseUrl: saved.url, imageComfyCheckpoint: saved.ckpt });
});

describe('upscaling on ComfyUI', () => {
	it('is offered only when models/upscale_models has Real-ESRGAN x4plus', async () => {
		server(['RealESRGAN_x4plus_anime_6B.pth', '4x-UltraSharp.pth']);
		expect((await comfyUiBackend.capabilities()).upscale).toBe(false);
		server(['RealESRGAN_x4plus.pth']);
		expect((await comfyUiBackend.capabilities()).upscale).toBe(true);
	});

	it('finds the upscaler under a name of its own, but not an anime or ×2 one', async () => {
		server(['RealESRGAN_x2plus.pth', 'esrgan/RealESRGAN-x4plus.pth']);
		expect(await findUpscaler({ baseUrl: 'http://box:8188', apiKey: '' })).toBe(
			'esrgan/RealESRGAN-x4plus.pth'
		);
	});

	it('runs the picture through the upscaler and returns what it saved', async () => {
		server(['RealESRGAN_x4plus.pth']);
		const out = await comfyUiBackend.upscale!({ name: 'car.png', bytes: [1, 2, 3] });
		expect([...out]).toEqual([...PNG]);
		const graph = submitted();
		expect(graph['1']).toEqual({ class_type: 'LoadImage', inputs: { image: 'up.png' } });
		expect(graph['2'].inputs.model_name).toBe('RealESRGAN_x4plus.pth');
		expect(graph['3'].class_type).toBe('ImageUpscaleWithModel');
		expect(graph['4'].inputs.filename_prefix).toMatch(/^haruspex\//);
	});

	it('says how to install the upscaler when the server has none', async () => {
		server([]);
		await expect(comfyUiBackend.upscale!({ name: 'car.png', bytes: [1] })).rejects.toThrow(
			/models\/upscale_models — Settings → Image → Install/
		);
	});

	it('wires the loader into the upscale and the upscale into the save', () => {
		const g = upscaleGraph('a.png', 'm.pth', 'haruspex/x');
		expect(g['3'].inputs).toEqual({ upscale_model: ['2', 0], image: ['1', 0] });
		expect(g['4'].inputs.images).toEqual(['3', 0]);
	});
});
