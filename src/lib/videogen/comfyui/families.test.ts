import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listVideoModels, missingNodes, resolveCompanions, videoFamilyOf } from './families';

const cfg = { baseUrl: 'http://box:8188', apiKey: '' };

/** `object_info/<class>` answers, by class: the options of its one listed input. */
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

describe('the video families', () => {
	it('reads each family from its file name, never the 14B low-noise half', () => {
		expect(videoFamilyOf('wan2.2_ti2v_5B_fp16.safetensors')).toBe('wan22_ti2v_5b');
		expect(videoFamilyOf('wan/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors')).toBe(
			'wan22_i2v_14b'
		);
		expect(videoFamilyOf('wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors')).toBeNull();
		expect(videoFamilyOf('wan2.2_s2v_14B_fp8_scaled.safetensors')).toBe('wan22_s2v');
		expect(videoFamilyOf('ltx-2.3-22b-dev-fp8.safetensors')).toBe('ltx23');
		expect(videoFamilyOf('qwen_image_2.1_turbo.safetensors')).toBeNull();
	});

	it('lists the diffusion models and checkpoints a family runs', async () => {
		lists = {
			UNETLoader: {
				unet_name: [
					'wan2.2_ti2v_5B_fp16.safetensors',
					'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
					'ming.safetensors'
				]
			},
			CheckpointLoaderSimple: { ckpt_name: ['ltx-2.3-22b-dev-fp8.safetensors', 'sd15.ckpt'] }
		};
		expect(await listVideoModels(cfg)).toEqual([
			{ name: 'wan2.2_ti2v_5B_fp16.safetensors', family: 'wan22_ti2v_5b' },
			{ name: 'ltx-2.3-22b-dev-fp8.safetensors', family: 'ltx23' }
		]);
	});

	it('finds the files a family loads beside its model, and names the missing ones', async () => {
		lists = {
			CLIPLoader: { clip_name: ['umt5_xxl_fp8_e4m3fn_scaled.safetensors'] },
			VAELoader: { vae_name: ['wan_2.1_vae.safetensors', 'wan2.2_vae.safetensors'] },
			UNETLoader: { unet_name: ['wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors'] },
			LoraLoaderModelOnly: {
				lora_name: ['wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors']
			}
		};
		expect(await resolveCompanions(cfg, 'wan22_ti2v_5b')).toEqual({
			found: {
				textEncoder: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
				vae: 'wan2.2_vae.safetensors'
			},
			missing: []
		});
		const big = await resolveCompanions(cfg, 'wan22_i2v_14b');
		expect(big.found.vae).toBe('wan_2.1_vae.safetensors');
		expect(big.found.lowNoise).toBe('wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors');
		expect(big.missing).toEqual(['the lightx2v 4-step low-noise LoRA']);
	});

	it('names the core nodes an older ComfyUI lacks', async () => {
		lists = { Wan22ImageToVideoLatent: {}, CreateVideo: {} };
		expect(await missingNodes(cfg, 'wan22_ti2v_5b')).toEqual(['SaveVideo']);
	});
});
