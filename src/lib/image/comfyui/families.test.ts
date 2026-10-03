import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { familyOf, pickCompanion, resolveCompanions, hasModel } from './families';

describe('familyOf', () => {
	it('recognises the DiT families by the filenames they ship under', () => {
		expect(familyOf('ming_image_0.1_design_int8_convrot.safetensors')).toBe('ming');
		expect(familyOf('Ming-Image-0.1-Design-Q4.gguf')).toBe('ming');
		expect(familyOf('qwen_image_2.1_int8_convrot.safetensors')).toBe('qwen21');
		expect(familyOf('Qwen-Image-2.1-Q4_K_M.gguf')).toBe('qwen21');
	});

	it('treats anything else as an SD checkpoint, so old settings keep working', () => {
		expect(familyOf('sd_xl_base_1.0.safetensors')).toBe('sd');
		expect(familyOf('')).toBe('sd');
		// The earlier Qwen-Image is not 2.1 and has no alpha.
		expect(familyOf('qwen_image_2512_fp8.safetensors')).toBe('sd');
	});
});

describe('pickCompanion', () => {
	const encoders = [
		'clip_l.safetensors',
		'ming_image_0.1_ling_mini_2.0_bf16.safetensors',
		'ming_image_0.1_ling_mini_2.0_int8_convrot.safetensors',
		'ming_image_0.1_ling_mini_2.0_layer_int8_convrot.safetensors',
		'ming_image_0.1_ling_mini_2.0_w4a8.safetensors'
	];

	it('takes the best match by preference, not by list order', () => {
		expect(pickCompanion(encoders, [/^ming_image.*ling.*w4a8/, /^ming_image.*ling/])).toBe(
			'ming_image_0.1_ling_mini_2.0_w4a8.safetensors'
		);
	});

	it('falls through the preferences', () => {
		const noW4 = encoders.filter((e) => !e.includes('w4a8'));
		expect(pickCompanion(noW4, [/^ming_image.*ling.*w4a8/, /^ming_image.*ling.*int8/])).toBe(
			'ming_image_0.1_ling_mini_2.0_int8_convrot.safetensors'
		);
	});

	it('never picks the layer-decomposition encoder or a prompt rewriter', () => {
		// Same prefix, different model.
		expect(
			pickCompanion(
				['ming_image_0.1_ling_mini_2.0_layer_int8_convrot.safetensors'],
				[/^ming_image/]
			)
		).toBeNull();
		expect(
			pickCompanion(
				['qwen3vl_8b_pe_t2i.safetensors', 'qwen3vl_8b_int8.safetensors'],
				[/^qwen3vl_8b/]
			)
		).toBe('qwen3vl_8b_int8.safetensors');
	});

	it('returns null when nothing matches', () => {
		expect(pickCompanion(['clip_l.safetensors'], [/^ming/])).toBeNull();
	});
});

describe('resolveCompanions', () => {
	let lists: Record<string, string[]>;
	beforeEach(() => {
		lists = {
			CLIPLoader: ['ming_image_0.1_ling_mini_2.0_w4a8.safetensors'],
			VAELoader: ['ae.safetensors', 'ming_image_vae_bf16.safetensors']
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				const cls = url.split('/object_info/')[1];
				const input =
					cls === 'CLIPLoader' ? 'clip_name' : cls === 'UNETLoader' ? 'unet_name' : 'vae_name';
				return {
					ok: true,
					status: 200,
					json: async () => ({ [cls]: { input: { required: { [input]: [lists[cls]] } } } }),
					text: async () =>
						JSON.stringify({ [cls]: { input: { required: { [input]: [lists[cls]] } } } })
				} as Response;
			})
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	const cfg = { baseUrl: 'http://box:8188', apiKey: '' };

	it("finds both files in the server's own lists", async () => {
		expect(await resolveCompanions(cfg, 'ming')).toEqual({
			textEncoder: 'ming_image_0.1_ling_mini_2.0_w4a8.safetensors',
			vae: 'ming_image_vae_bf16.safetensors'
		});
	});

	it('names the missing file rather than submitting a graph the server refuses', async () => {
		lists.VAELoader = ['ae.safetensors'];
		await expect(resolveCompanions(cfg, 'ming')).rejects.toMatchObject({
			kind: 'unconfigured',
			message: expect.stringMatching(/Ming-Image VAE.*Settings → Image → Install/)
		});
	});

	it('treats an empty list as having none, not as "would not say"', async () => {
		// A server with no models at all probed as "Connected".
		lists.UNETLoader = [];
		expect(await hasModel(cfg, 'ming', 'ming_image_0.1_design_int8_convrot.safetensors')).toBe(
			false
		);
	});
});
