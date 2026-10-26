import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import { comfyUiBackend } from './backend';
import type { ImageRequest } from '../types';

const saved = {
	url: getSettings().imageBackendBaseUrl,
	ckpt: getSettings().imageComfyCheckpoint
};

const MING = 'ming_image_0.1_design_int8_convrot.safetensors';
const QWEN21 = 'qwen_image_2.1_int8_convrot.safetensors';
const TURBO = 'qwen_image_2.1_turbo_int8_convrot.safetensors';
const KLEIN = 'flux-2-klein-4b-fp8.safetensors';

/** A 1184×880 PNG's first bytes: signature, then the IHDR with its size. */
const PNG_1184x880 = new Uint8Array([
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 160, 0, 0, 3, 112
]);

const LISTS: Record<string, [string, string[]]> = {
	UNETLoader: ['unet_name', [MING, QWEN21, TURBO, KLEIN]],
	CLIPLoader: [
		'clip_name',
		[
			'ming_image_0.1_ling_mini_2.0_w4a8.safetensors',
			'qwen3vl_8b_int8_convrot.safetensors',
			'qwen_3_4b.safetensors'
		]
	],
	VAELoader: [
		'vae_name',
		[
			'ming_image_vae_bf16.safetensors',
			'qwen_image_2.1_vae_bf16.safetensors',
			'flux2-vae.safetensors'
		]
	]
};

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * A server that takes uploads, queues, finishes at once and serves one PNG.
 * With `encoderTakesImages`, its Qwen-Image-2.1 encoder lists `images` and
 * `vae`, as ComfyUI 0.39's does.
 */
function server(opts: { encoderTakesImages?: boolean; referenceLatent?: boolean } = {}) {
	fetchMock.mockImplementation(async (url: string) => {
		const body = (b: unknown) =>
			({
				ok: true,
				status: 200,
				json: async () => b,
				text: async () => JSON.stringify(b),
				arrayBuffer: async () => PNG_1184x880.buffer
			}) as Response;
		if (url.includes('/upload/image')) return body({ name: 'uploaded.png', subfolder: '' });
		if (url.includes('/prompt')) return body({ prompt_id: 'p1' });
		if (url.includes('/history'))
			return body({
				p1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } }
			});
		if (url.includes('/object_info/TextEncodeQwenImage21')) {
			const optional = opts.encoderTakesImages ? { vae: ['VAE'], images: ['AUTOGROW'] } : {};
			return body({ TextEncodeQwenImage21: { input: { required: { clip: ['CLIP'] }, optional } } });
		}
		if (url.includes('/object_info/ReferenceLatent')) {
			return body(
				opts.referenceLatent
					? { ReferenceLatent: { input: { required: { conditioning: ['CONDITIONING'] } } } }
					: {}
			);
		}
		const cls = url.split('/object_info/')[1];
		if (cls && LISTS[cls]) {
			const [input, names] = LISTS[cls];
			return body({ [cls]: { input: { required: { [input]: [names] } } } });
		}
		return body({});
	});
}

function submitted(): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
	const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/prompt'))!;
	return JSON.parse((call[1] as RequestInit).body as string).prompt;
}

const edit = (over: Partial<ImageRequest> = {}): ImageRequest => ({
	prompt: 'make it night',
	width: 1024,
	height: 768,
	seed: 7,
	edit: {
		images: [
			{ name: 'a.png', bytes: [1, 2, 3] },
			{ name: 'b.png', bytes: [4, 5] }
		]
	},
	...over
});

beforeEach(() => {
	updateSettings({ imageBackendBaseUrl: 'http://box:8188', imageComfyCheckpoint: QWEN21 });
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

describe('ComfyUI edits', () => {
	it('edits with Qwen-Image-2.1 only when the server’s encoder takes pictures', async () => {
		// A different address each time: the answer is remembered per server.
		updateSettings({ imageBackendBaseUrl: 'http://new:8188' });
		server({ encoderTakesImages: true });
		expect(await comfyUiBackend.capabilities()).toMatchObject({ edit: true, maxEditImages: 3 });
		updateSettings({ imageBackendBaseUrl: 'http://old:8188' });
		server({ encoderTakesImages: false });
		expect(await comfyUiBackend.capabilities()).toMatchObject({ edit: false, maxEditImages: 0 });
		updateSettings({ imageComfyCheckpoint: MING });
		expect(await comfyUiBackend.capabilities()).toMatchObject({ edit: false });
	});

	it('uploads each picture and wires one LoadImage per picture into the encoder', async () => {
		server({ encoderTakesImages: true });
		const r = await comfyUiBackend.generate(edit());
		const uploads = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/upload/image'));
		expect(uploads).toHaveLength(2);
		const form = (uploads[0][1] as RequestInit).body as FormData;
		expect(form.get('overwrite')).toBe('true');
		expect((form.get('image') as File).name).toMatch(/^haruspex-edit-.+\.png$/);
		const g = submitted();
		expect(g['4'].class_type).toBe('TextEncodeQwenImage21');
		expect(g['4'].inputs['images.image_1']).toEqual(['edit_image_1', 0]);
		expect(g['4'].inputs['images.image_2']).toEqual(['edit_image_2', 0]);
		expect(g['edit_image_1']).toEqual({
			class_type: 'LoadImage',
			inputs: { image: 'uploaded.png' }
		});
		expect(g['4'].inputs.vae).toEqual(['3', 0]);
		// Sampling starts from the encoder's latent, sized from the first picture.
		expect(g['7'].inputs.latent_image).toEqual(['4', 2]);
		expect(g['4'].inputs.resolution).toBe(896);
		expect(g['4'].inputs.prompt).toBe('make it night');
		// The size comes from the PNG that came back, not the request.
		expect(r.images[0]).toMatchObject({ width: 1184, height: 880 });
	});

	it('uses the Turbo edit graph for Turbo', async () => {
		updateSettings({ imageComfyCheckpoint: TURBO });
		server({ encoderTakesImages: true });
		await comfyUiBackend.generate(edit());
		const g = submitted();
		expect(g['11'].class_type).toBe('ManualSigmas');
		expect(g['7'].inputs.latent_image).toEqual(['4', 2]);
	});

	it('edits with FLUX.2 klein, up to four pictures, when the server has ReferenceLatent', async () => {
		updateSettings({ imageBackendBaseUrl: 'http://klein:8188', imageComfyCheckpoint: KLEIN });
		server({ referenceLatent: true });
		expect(await comfyUiBackend.capabilities()).toMatchObject({ edit: true, maxEditImages: 4 });
		updateSettings({ imageBackendBaseUrl: 'http://older:8188' });
		server({ referenceLatent: false });
		expect(await comfyUiBackend.capabilities()).toMatchObject({ edit: false });
	});

	it('chains each klein picture onto both conditionings, sized from the first', async () => {
		updateSettings({ imageComfyCheckpoint: KLEIN });
		server({ referenceLatent: true });
		await comfyUiBackend.generate(edit());
		const g = submitted();
		expect(g['edit_scale_1'].inputs).toMatchObject({
			image: ['edit_image_1', 0],
			megapixels: 0.75
		});
		expect(g['edit_latent_2'].inputs).toEqual({ pixels: ['edit_scale_2', 0], vae: ['3', 0] });
		// positive: prompt → picture 1 → picture 2; negative the same from the zeroed one.
		expect(g['edit_positive_1'].inputs.conditioning).toEqual(['4', 0]);
		expect(g['edit_positive_2'].inputs.conditioning).toEqual(['edit_positive_1', 0]);
		expect(g['edit_negative_1'].inputs.conditioning).toEqual(['5', 0]);
		expect(g['11'].inputs).toMatchObject({
			positive: ['edit_positive_2', 0],
			negative: ['edit_negative_2', 0]
		});
		expect(g['14'].inputs.image).toEqual(['edit_scale_1', 0]);
		expect(g['6'].inputs.width).toEqual(['14', 0]);
		expect(g['10'].inputs).toMatchObject({ steps: 4, height: ['14', 1] });
		expect(g['2'].inputs).toMatchObject({ clip_name: 'qwen_3_4b.safetensors', type: 'flux2' });
		expect(g['3'].inputs.vae_name).toBe('flux2-vae.safetensors');
	});

	it('draws with klein at the size asked for', async () => {
		updateSettings({ imageComfyCheckpoint: KLEIN });
		server();
		await comfyUiBackend.generate(edit({ edit: undefined }));
		const g = submitted();
		expect(g['6'].inputs).toMatchObject({ width: 1024, height: 768 });
		expect(g['10'].inputs).toMatchObject({ width: 1024, height: 768, steps: 4 });
		expect(g['edit_image_1']).toBeUndefined();
	});

	it('refuses an edit for a model with no edit workflow, before uploading', async () => {
		updateSettings({ imageComfyCheckpoint: MING });
		server();
		await expect(comfyUiBackend.generate(edit())).rejects.toMatchObject({
			kind: 'unconfigured',
			message: expect.stringContaining("can't edit pictures")
		});
		const sent = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(sent.some((u) => u.includes('/upload/image') || u.includes('/prompt'))).toBe(false);
	});
});
