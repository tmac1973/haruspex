import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { missingVideoFiles } from './provision';
import type { ComfyModelSet } from '#lib/ipc/gen/ComfyModelSet.ts';
import type { ComfyModelFile } from '#lib/ipc/gen/ComfyModelFile.ts';

const cfg = { baseUrl: 'http://box:8188', apiKey: '' };
let lists: Record<string, Record<string, string[]>> = {};

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			const cls = decodeURIComponent(url.split('/object_info/')[1] ?? '');
			const inputs = lists[cls];
			const body = inputs
				? {
						[cls]: {
							input: {
								required: Object.fromEntries(
									Object.entries(inputs).map(([k, v]) => [k, ['COMBO', { options: v }]])
								)
							}
						}
					}
				: {};
			return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

const file = (folder: ComfyModelFile['folder'], filename: string): ComfyModelFile => ({
	folder,
	filename,
	url: `https://example.com/${filename}`,
	sha256: '0'.repeat(64),
	size_bytes: 1
});

const S2V: ComfyModelSet = {
	family: 'wan22_s2v',
	kind: 'video',
	label: 'Wan 2.2 S2V',
	license: 'Apache 2.0',
	license_url: '',
	commercial_use: true,
	vram_mb: 1,
	ram_mb: 1,
	files: [
		file('diffusion_models', 'wan2.2_s2v_14B_fp8_scaled.safetensors'),
		file('text_encoders', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
		file('vae', 'wan_2.1_vae.safetensors'),
		file('audio_encoders', 'wav2vec2_large_english_fp16.safetensors'),
		file('loras', 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors')
	]
};

describe('missingVideoFiles', () => {
	it('is every file on an empty server', async () => {
		lists = {};
		expect((await missingVideoFiles(cfg, S2V)).map((f) => f.folder)).toEqual([
			'diffusion_models',
			'text_encoders',
			'vae',
			'audio_encoders',
			'loras'
		]);
	});

	it('counts a file there by name, or another build that does its job', async () => {
		lists = {
			UNETLoader: { unet_name: ['wan/wan2.2_s2v_14B_fp8_scaled.safetensors'] },
			// Another build of the same encoder: the workflow takes it.
			CLIPLoader: { clip_name: ['umt5_xxl_fp16.safetensors'] },
			VAELoader: { vae_name: ['wan_2.1_vae.safetensors'] },
			AudioEncoderLoader: { audio_encoder_name: [] },
			LoraLoaderModelOnly: { lora_name: [] }
		};
		expect((await missingVideoFiles(cfg, S2V)).map((f) => f.filename)).toEqual([
			'wav2vec2_large_english_fp16.safetensors',
			'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors'
		]);
	});
});
