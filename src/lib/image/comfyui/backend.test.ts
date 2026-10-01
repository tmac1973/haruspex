import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSettings, updateSettings } from '$lib/stores/settings';
import { comfyUiBackend, DEFAULT_SAMPLER } from './backend';
import { TEMPLATES } from './templates';
import type { ImageRequest } from '../types';

const saved = {
	url: getSettings().imageBackendBaseUrl,
	key: getSettings().imageBackendApiKey,
	ckpt: getSettings().imageComfyCheckpoint,
	wf: getSettings().imageComfyWorkflowPath,
	fm: getSettings().imageComfyFieldMapPath
};

const MING = 'ming_image_0.1_design_int8_convrot.safetensors';
const QWEN21 = 'qwen_image_2.1_int8_convrot.safetensors';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	updateSettings({
		imageBackendBaseUrl: 'http://box:8188',
		imageBackendApiKey: '',
		imageComfyCheckpoint: 'sd15.safetensors',
		imageComfyWorkflowPath: '',
		imageComfyFieldMapPath: ''
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
	updateSettings({
		imageBackendBaseUrl: saved.url,
		imageBackendApiKey: saved.key,
		imageComfyCheckpoint: saved.ckpt,
		imageComfyWorkflowPath: saved.wf,
		imageComfyFieldMapPath: saved.fm
	});
});

const req = (over: Partial<ImageRequest> = {}): ImageRequest => ({
	prompt: 'a tin can',
	width: 512,
	height: 512,
	seed: 7,
	...over
});

/** What the server's loaders list, by class: [input name, files]. */
const LISTS: Record<string, [string, string[]]> = {
	CheckpointLoaderSimple: ['ckpt_name', ['sd15.safetensors', 'sdxl.safetensors']],
	UNETLoader: ['unet_name', [MING, QWEN21]],
	CLIPLoader: [
		'clip_name',
		['ming_image_0.1_ling_mini_2.0_w4a8.safetensors', 'qwen3vl_8b_int8_convrot.safetensors']
	],
	VAELoader: [
		'vae_name',
		['ming_image_vae_bf16.safetensors', 'qwen_image_2.1_vae_bf16.safetensors']
	]
};

/** A server that queues, finishes immediately, and serves one PNG. */
function happyServer() {
	fetchMock.mockImplementation(async (url: string) => {
		const body = (b: unknown) =>
			({
				ok: true,
				status: 200,
				json: async () => b,
				text: async () => '',
				arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer
			}) as Response;
		if (url.includes('/prompt')) return body({ prompt_id: 'p1' });
		if (url.includes('/history'))
			return body({
				p1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } }
			});
		if (url.includes('/system_stats')) return body({ devices: [{ name: 'AMD R9700' }] });
		const cls = url.split('/object_info/')[1];
		if (cls && LISTS[cls]) {
			const [input, names] = LISTS[cls];
			return body({ [cls]: { input: { required: { [input]: [names] } } } });
		}
		return body({});
	});
}

/** The graph that was submitted to /prompt, nth call. */
function submitted(n = 0): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
	const calls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/prompt'));
	return JSON.parse((calls[n][1] as RequestInit).body as string).prompt;
}

describe('capabilities', () => {
	it("are computed from the configured model's workflows, not asserted", async () => {
		expect(await comfyUiBackend.capabilities()).toEqual({
			transparency: false,
			seamlessTiling: true,
			loras: true,
			maxLoras: 2
		});
	});

	it('change with the model: Ming gives alpha, and neither tiles nor takes LoRAs', async () => {
		updateSettings({ imageComfyCheckpoint: MING });
		expect(await comfyUiBackend.capabilities()).toEqual({
			transparency: true,
			seamlessTiling: false,
			loras: false,
			maxLoras: 0
		});
	});
});

describe('probe', () => {
	it('fails with one sentence when no URL is set', async () => {
		updateSettings({ imageBackendBaseUrl: '' });
		expect(await comfyUiBackend.probe()).toEqual({
			ok: false,
			detail: 'No backend URL is set — Settings → Image.'
		});
	});

	it('fails when no model is set, before any run starts', async () => {
		// A missing model must surface at Probe, not forty images in.
		updateSettings({ imageComfyCheckpoint: '' });
		happyServer();
		const r = await comfyUiBackend.probe();
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/No model is set/);
	});

	it('names the device it found on success', async () => {
		happyServer();
		expect(await comfyUiBackend.probe()).toEqual({ ok: true, detail: 'Connected — AMD R9700.' });
	});

	it('checks a DiT model and its companion files, naming what is missing', async () => {
		updateSettings({ imageComfyCheckpoint: MING });
		happyServer();
		expect((await comfyUiBackend.probe()).ok).toBe(true);

		updateSettings({ imageComfyCheckpoint: 'ming_image_missing.safetensors' });
		const r = await comfyUiBackend.probe();
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/diffusion model called/);
	});

	it('refuses a half-configured custom workflow, naming the missing half', async () => {
		updateSettings({ imageComfyWorkflowPath: '/tmp/wf.json' });
		const r = await comfyUiBackend.probe();
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/field map is not/);
	});

	it('refuses the mirror case too', async () => {
		updateSettings({ imageComfyFieldMapPath: '/tmp/map.json' });
		const r = await comfyUiBackend.probe();
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/workflow is not/);
	});

	it('surfaces an unreachable backend rather than throwing', async () => {
		fetchMock.mockRejectedValue(new TypeError('fetch failed'));
		const r = await comfyUiBackend.probe();
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/Could not reach/);
	});
});

describe('generate', () => {
	it('returns bytes and reports what actually ran', async () => {
		happyServer();
		const result = await comfyUiBackend.generate(req());
		expect(result.images).toHaveLength(1);
		expect(result.images[0].mimeType).toBe('image/png');
		// The sampler comes back resolved, not absent — the anchor recipe has
		// to record what really ran, and the request set nothing.
		expect(result.meta.sampler).toEqual(DEFAULT_SAMPLER);
		expect(result.meta.model).toBe('sd15.safetensors');
		expect(result.meta.backend).toBe('comfyui');
	});

	it('resolves an unset model to the configured checkpoint', async () => {
		happyServer();
		await comfyUiBackend.generate(req());
		expect(submitted()['1'].inputs.ckpt_name).toBe('sd15.safetensors');
	});

	it('lets an explicit model win over the configured one', async () => {
		happyServer();
		const r = await comfyUiBackend.generate(req({ model: 'sdxl.safetensors' }));
		expect(r.meta.model).toBe('sdxl.safetensors');
	});

	it('picks the workflow by the REQUESTED model, not the configured one', async () => {
		// A spec pins its model; a Ming spec run with an SD default configured
		// must still get the Ming graph.
		happyServer();
		await comfyUiBackend.generate(req({ model: MING }));
		expect(submitted()['1'].class_type).toBe('UNETLoader');
	});

	it('resolves a null seed to a real one, applies it, and reports it', async () => {
		// A null seed used to fall through to the template's 0: every unpinned
		// request was the same picture, and meta reported a seed nobody chose.
		happyServer();
		const a = await comfyUiBackend.generate(req({ seed: null }));
		const b = await comfyUiBackend.generate(req({ seed: null }));
		expect(submitted(0)['7'].inputs.seed).toBe(a.meta.seed);
		expect(submitted(1)['7'].inputs.seed).toBe(b.meta.seed);
		expect(a.meta.seed).not.toBe(b.meta.seed);
	});

	it('leaves a pinned seed alone', async () => {
		happyServer();
		const r = await comfyUiBackend.generate(req({ seed: 7 }));
		expect(submitted()['7'].inputs.seed).toBe(7);
		expect(r.meta.seed).toBe(7);
	});

	it('runs a transparent Ming request from a transparent canvas of the requested size', async () => {
		updateSettings({ imageComfyCheckpoint: MING });
		happyServer();
		const r = await comfyUiBackend.generate(req({ transparent: true, width: 1024, height: 768 }));
		const g = submitted();
		expect(g['6'].class_type).toBe('VAEEncode');
		expect(g['10'].inputs.denoise).toBe(0.9);
		expect([g['14'].inputs.width, g['15'].inputs.width]).toEqual([1024, 1024]);
		expect([g['14'].inputs.height, g['15'].inputs.height]).toEqual([768, 768]);
		// Its companions came from the server's own lists, and nothing was
		// uploaded: the canvas is built inside the graph.
		expect(g['1'].inputs.unet_name).toBe(MING);
		expect(g['2'].inputs.clip_name).toBe('ming_image_0.1_ling_mini_2.0_w4a8.safetensors');
		expect(g['3'].inputs.vae_name).toBe('ming_image_vae_bf16.safetensors');
		expect(g['7'].inputs.noise_seed).toBe(7);
		expect(g['4'].inputs.text).toBe('RGBA, 4-channel, transparent background. a tin can');
		expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/upload'))).toBe(false);
		// The sampler reported is the one the Ming graph ran, not SD's.
		expect(r.meta.sampler).toEqual(TEMPLATES.find((t) => t.id === 'ming_t2i_rgba')!.defaultSampler);
	});

	it('runs an opaque Ming request from an empty latent at full denoise', async () => {
		updateSettings({ imageComfyCheckpoint: MING });
		happyServer();
		await comfyUiBackend.generate(req());
		const g = submitted();
		expect(g['6'].class_type).toBe('EmptyLatentImage');
		expect(g['10'].inputs.denoise).toBe(1);
	});

	it('wraps the prompt for a transparent Qwen-Image-2.1 request, and only then', async () => {
		updateSettings({ imageComfyCheckpoint: QWEN21 });
		happyServer();
		await comfyUiBackend.generate(req({ transparent: true }));
		await comfyUiBackend.generate(req());
		expect(submitted(0)['4'].inputs.prompt).toMatch(/^This is an RGBA format image.*a tin can/);
		expect(submitted(1)['4'].inputs.prompt).toBe('a tin can');
		expect(submitted(0)['2'].inputs.clip_name).toBe('qwen3vl_8b_int8_convrot.safetensors');
	});

	it('asks an SD checkpoint for no alpha it cannot give', async () => {
		happyServer();
		await comfyUiBackend.generate(req({ transparent: true }));
		const g = submitted();
		expect(g['4'].inputs.text).toBe('a tin can');
		expect(g['1'].inputs.ckpt_name).toBe('sd15.safetensors');
	});

	it('drops LoRAs beyond the number of slots the workflow has', async () => {
		happyServer();
		const r = await comfyUiBackend.generate(
			req({
				loras: [
					{ name: 'a', strength: 1 },
					{ name: 'b', strength: 1 },
					{ name: 'c', strength: 1 }
				]
			})
		);
		// Reported honestly in meta, so the recipe records what ran.
		expect(r.meta.loras).toHaveLength(2);
	});

	it('gives every request a unique output prefix', async () => {
		// Concurrent submissions must not be confusable in /history.
		happyServer();
		await comfyUiBackend.generate(req());
		await comfyUiBackend.generate(req());
		expect(submitted(0)['9'].inputs.filename_prefix).not.toBe(
			submitted(1)['9'].inputs.filename_prefix
		);
	});

	it('reports cancellation as `cancelled`', async () => {
		happyServer();
		const c = new AbortController();
		c.abort();
		await expect(comfyUiBackend.generate(req(), { signal: c.signal })).rejects.toMatchObject({
			kind: 'cancelled'
		});
	});

	it('emits progress while it waits', async () => {
		happyServer();
		const seen: string[] = [];
		await comfyUiBackend.generate(req(), { onProgress: (p) => seen.push(p.phase) });
		expect(seen).toContain('downloading');
	});
});
