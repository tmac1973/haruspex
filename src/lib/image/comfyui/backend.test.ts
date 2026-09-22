import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSettings, updateSettings } from '$lib/stores/settings';
import { comfyUiBackend, DEFAULT_SAMPLER } from './backend';
import type { ImageRequest } from '../types';

const saved = {
	url: getSettings().imageBackendBaseUrl,
	key: getSettings().imageBackendApiKey,
	ckpt: getSettings().imageComfyCheckpoint,
	wf: getSettings().imageComfyWorkflowPath,
	fm: getSettings().imageComfyFieldMapPath
};

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
		if (url.includes('/upload/image')) return body({ name: 'ref.png', subfolder: '' });
		if (url.includes('/history'))
			return body({
				p1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } }
			});
		if (url.includes('/system_stats')) return body({ devices: [{ name: 'AMD R9700' }] });
		return body({});
	});
}

describe('capabilities', () => {
	it('are computed from the bundled workflows, not asserted', () => {
		return comfyUiBackend.capabilities().then((c) => {
			expect(c).toEqual({
				referenceConditioning: true,
				seamlessTiling: true,
				loras: true,
				maxLoras: 2
			});
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

	it('fails when no checkpoint is set, before any run starts', async () => {
		// A missing checkpoint must surface at Probe, not forty images in.
		updateSettings({ imageComfyCheckpoint: '' });
		happyServer();
		const r = await comfyUiBackend.probe();
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/checkpoint/i);
	});

	it('names the device it found on success', async () => {
		happyServer();
		expect(await comfyUiBackend.probe()).toEqual({ ok: true, detail: 'Connected — AMD R9700.' });
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
		const submitted = fetchMock.mock.calls.find((c) => String(c[0]).includes('/prompt'));
		const graph = JSON.parse((submitted![1] as RequestInit).body as string).prompt;
		expect(graph['1'].inputs.ckpt_name).toBe('sd15.safetensors');
	});

	it('lets an explicit model win over the configured one', async () => {
		happyServer();
		const r = await comfyUiBackend.generate(req({ model: 'sdxl.safetensors' }));
		expect(r.meta.model).toBe('sdxl.safetensors');
	});

	it('uploads a reference before submitting, and binds the filename', async () => {
		happyServer();
		await comfyUiBackend.generate(req({ referenceImage: new Uint8Array([1, 2]) }));
		const order = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(order.findIndex((u) => u.includes('/upload/image'))).toBeLessThan(
			order.findIndex((u) => u.includes('/prompt'))
		);
		const submitted = fetchMock.mock.calls.find((c) => String(c[0]).includes('/prompt'));
		const graph = JSON.parse((submitted![1] as RequestInit).body as string).prompt;
		expect(graph['6'].inputs.image).toBe('ref.png');
	});

	it('keeps the reference on a request that is also seamless', async () => {
		// The fourth template's whole reason for existing: three would drop one
		// of the two and record no degradation.
		happyServer();
		await comfyUiBackend.generate(req({ referenceImage: new Uint8Array([1]), seamless: true }));
		const submitted = fetchMock.mock.calls.find((c) => String(c[0]).includes('/prompt'));
		const graph = JSON.parse((submitted![1] as RequestInit).body as string).prompt;
		expect(graph['6'].inputs.image).toBe('ref.png');
		expect(graph['11'].class_type).toBe('SeamlessTile');
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
		const prefixes = fetchMock.mock.calls
			.filter((c) => String(c[0]).includes('/prompt'))
			.map(
				(c) => JSON.parse((c[1] as RequestInit).body as string).prompt['9'].inputs.filename_prefix
			);
		expect(prefixes[0]).not.toBe(prefixes[1]);
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
