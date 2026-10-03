import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageBackendError, type ImageBackendCapabilities, type ImageRequest } from './types';

const state = vi.hoisted(() => ({
	kind: 'local' as string,
	localModel: 'ming',
	comfyCheckpoint: '',
	probe: { ok: true, detail: 'ok' } as { ok: boolean; detail: string },
	caps: {
		transparency: true,
		seamlessTiling: true,
		loras: false,
		maxLoras: 0
	} as ImageBackendCapabilities,
	generate: vi.fn()
}));

vi.mock('./backend', () => ({
	resolveImageBackend: () => ({
		kind: state.kind,
		probe: async () => state.probe,
		capabilities: async () => state.caps,
		generate: state.generate
	})
}));
vi.mock('$lib/stores/settings', () => ({
	getSettings: () => ({
		imageBackendKind: state.kind,
		imageLocalModelId: state.localModel,
		imageComfyCheckpoint: state.comfyCheckpoint
	})
}));

import { generateForTool, GPU_FULL_SENTENCE } from './forTool';

const req = (over: Partial<ImageRequest> = {}): ImageRequest => ({
	prompt: 'a lighthouse',
	width: 1024,
	height: 1024,
	seed: null,
	...over
});

const drawn = (seamFailed?: string) => ({
	images: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', width: 1024, height: 1024 }],
	meta: {
		seed: 7,
		model: 'ming',
		backend: 'local',
		sampler: { name: 'euler', steps: 12, cfg: 1 },
		loras: [],
		durationMs: 1,
		...(seamFailed ? { seamFailed } : {})
	}
});

beforeEach(() => {
	state.kind = 'local';
	state.localModel = 'ming';
	state.comfyCheckpoint = '';
	state.probe = { ok: true, detail: 'ok' };
	state.caps = { transparency: true, seamlessTiling: true, loras: false, maxLoras: 0 };
	state.generate.mockReset().mockResolvedValue(drawn());
});

describe('generateForTool', () => {
	it('refuses with the Settings path when nothing is set up', async () => {
		state.kind = 'none';
		await expect(generateForTool(req())).rejects.toThrow(/Settings → Image/);
		expect(state.generate).not.toHaveBeenCalled();
	});

	it('passes the probe’s own reason on when the backend is not usable', async () => {
		state.probe = { ok: false, detail: 'No model is selected — Settings → Image.' };
		await expect(generateForTool(req())).rejects.toThrow('No model is selected');
	});

	it('drops what the backend cannot do, and says so', async () => {
		state.caps = { ...state.caps, transparency: false };
		const out = await generateForTool(req({ transparent: true }));
		expect(state.generate.mock.calls[0][0].transparent).toBe(false);
		expect(out.notes.join(' ')).toMatch(/cannot make transparent/);
	});

	it('turns a full GPU on the bundled engine into a sentence the user can act on', async () => {
		for (const detail of [
			'The image engine failed /sdapi/v1/img2img — 500 {"error":"generate_image returned no results"}',
			'vae encode compute failed',
			'model manager cannot make enough memory available on Vulkan0'
		]) {
			state.generate.mockRejectedValueOnce(new ImageBackendError('unreachable', detail));
			const err = await generateForTool(req()).catch((e: Error) => e);
			expect((err as Error).message).toContain(GPU_FULL_SENTENCE);
			expect((err as Error).message).toContain(detail);
		}
	});

	it('passes other failures through untouched', async () => {
		state.generate.mockRejectedValueOnce(new ImageBackendError('timeout', 'did not finish'));
		await expect(generateForTool(req())).rejects.toMatchObject({ kind: 'timeout' });
	});

	it('says when the model is licensed for non-commercial use only', async () => {
		state.localModel = 'qwen21';
		expect((await generateForTool(req())).notes.join(' ')).toMatch(/non-commercial/);
		state.localModel = 'ming';
		expect((await generateForTool(req())).notes.join(' ')).not.toMatch(/non-commercial/);
	});

	it('reports a texture that did not tile', async () => {
		state.generate.mockResolvedValueOnce(drawn('vae encode compute failed'));
		const out = await generateForTool(req({ seamless: true }));
		expect(out.notes.join(' ')).toMatch(/does not tile/);
	});
});
