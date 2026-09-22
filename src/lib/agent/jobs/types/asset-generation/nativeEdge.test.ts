import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nativeEdgeFor, upscaleForEdge } from './nativeEdge';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const settings = vi.hoisted(() => ({
	imageComfyCheckpoint: '',
	imageLocalModelId: ''
}));
vi.mock('$lib/stores/settings', () => ({ getSettings: () => settings }));

const CATALOGUE = [
	{ id: 'sd15', filename: 'v1-5-pruned-emaonly-fp16.safetensors', native_edge: 512 },
	{ id: 'sdxl', filename: 'sd_xl_base_1.0.safetensors', native_edge: 1024 }
];

beforeEach(() => {
	settings.imageComfyCheckpoint = '';
	settings.imageLocalModelId = '';
	invoke.mockReset().mockResolvedValue(CATALOGUE);
});

describe('upscaleForEdge', () => {
	it('puts generation at the model’s native resolution', () => {
		// The whole point: 32px targets want 16 on SD1.5 and 32 on SDXL.
		expect(upscaleForEdge(32, 512)).toBe(16);
		expect(upscaleForEdge(32, 1024)).toBe(32);
		expect(upscaleForEdge(64, 1024)).toBe(16);
	});

	it('never returns less than 1, whatever the target size', () => {
		// A target larger than the native edge would otherwise give a
		// fraction, and generating below native is the artefact case — so the
		// floor is the right failure.
		expect(upscaleForEdge(2048, 512)).toBe(1);
		expect(upscaleForEdge(0, 512)).toBeGreaterThanOrEqual(1);
	});

	it('does not ask for more than the pipeline will allocate', () => {
		expect(upscaleForEdge(1, 999_999)).toBeLessThanOrEqual(1024);
	});
});

describe('nativeEdgeFor', () => {
	it('matches the checkpoint configured for ComfyUI', () => {
		settings.imageComfyCheckpoint = 'sd_xl_base_1.0.safetensors';
		return expect(nativeEdgeFor(undefined)).resolves.toBe(1024);
	});

	it('matches a checkpoint given as a full path', () => {
		// ComfyUI reports bare filenames, but a spec may pin a path.
		settings.imageComfyCheckpoint = '/models/checkpoints/sd_xl_base_1.0.safetensors';
		return expect(nativeEdgeFor(undefined)).resolves.toBe(1024);
	});

	it('lets the spec’s pinned model win over the configured default', () => {
		// The spec pins the model for the whole set; that is the point of the
		// field, and the same precedence the request uses.
		settings.imageComfyCheckpoint = 'sd_xl_base_1.0.safetensors';
		return expect(nativeEdgeFor('v1-5-pruned-emaonly-fp16.safetensors')).resolves.toBe(512);
	});

	it('matches a bundled model by catalogue id', async () => {
		settings.imageLocalModelId = 'sdxl';
		await expect(nativeEdgeFor(undefined)).resolves.toBe(1024);
	});

	it('returns null for a checkpoint it does not recognise', async () => {
		// Never a guess. Inferring "xl" from a filename would be wrong
		// exactly when it matters — a fine-tune named for its style rather
		// than its base — and a wrong native edge is worse than none.
		settings.imageComfyCheckpoint = 'someones-pixel-mix-v4.safetensors';
		await expect(nativeEdgeFor(undefined)).resolves.toBeNull();
	});

	it('returns null when nothing is configured at all', async () => {
		await expect(nativeEdgeFor(undefined)).resolves.toBeNull();
	});

	it('returns null rather than throwing when the catalogue is unavailable', async () => {
		invoke.mockRejectedValue(new Error('no such command'));
		settings.imageComfyCheckpoint = 'sd_xl_base_1.0.safetensors';
		await expect(nativeEdgeFor(undefined)).resolves.toBeNull();
	});
});
