import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizeProfile } from './spec/types';

const state = vi.hoisted(() => ({
	caps: { transparency: true, seamlessTiling: true, loras: false, maxLoras: 0 },
	generate: vi.fn(),
	normalize: vi.fn(),
	check: vi.fn(),
	effective: vi.fn()
}));

vi.mock('$lib/image/forTool', () => ({ generateForTool: state.generate }));
vi.mock('$lib/image/backend', () => ({
	resolveImageBackend: () => ({ capabilities: async () => state.caps })
}));
vi.mock('./normalize', () => ({
	defaultProfile: async () => PROFILE,
	effectiveProfile: state.effective,
	normalizeImage: state.normalize,
	checkImage: state.check
}));

import { makeSingleAsset, pngSize } from './single';

const PROFILE = {
	target_size: 64,
	upscale: 4,
	palette: [0x112233ff],
	background: { color: 0xff00ffff },
	checks: {}
} as unknown as NormalizeProfile;

/** A PNG header claiming w×h — all `pngSize` reads. */
function png(w: number, h: number): Uint8Array {
	const b = new Uint8Array(24);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const v = new DataView(b.buffer);
	v.setUint32(16, w);
	v.setUint32(20, h);
	return b;
}

const drawn = (notes: string[] = [], seed = 3) => ({
	bytes: new Uint8Array([1]),
	width: 1024,
	height: 1024,
	notes,
	seed,
	model: 'ming'
});

beforeEach(() => {
	state.caps = { transparency: true, seamlessTiling: true, loras: false, maxLoras: 0 };
	state.generate.mockReset().mockResolvedValue(drawn());
	state.effective.mockReset().mockImplementation(async (p: NormalizeProfile) => p);
	state.normalize.mockReset().mockResolvedValue({ bytes: Array.from(png(32, 32)), stats: {} });
	state.check.mockReset().mockResolvedValue({ passed: true, failed: [] });
});

describe('makeSingleAsset', () => {
	it('draws a sprite on an alpha backend as a transparent sheet of one, at its own palette', async () => {
		const out = await makeSingleAsset({ kind: 'icon', prompt: 'a gold coin', size: 32 });
		expect(state.generate.mock.calls[0][0].transparent).toBe(true);
		const profile = state.effective.mock.calls[0][0] as NormalizeProfile;
		expect(profile.target_size).toBe(32);
		expect(profile.palette).toEqual([]);
		expect(out).toMatchObject({ width: 32, height: 32, checks: { passed: true } });
	});

	it('imposes a palette asked for, even on an alpha backend', async () => {
		await makeSingleAsset({ kind: 'sprite', prompt: 'a slime', palette: [0xff0000ff] });
		expect((state.effective.mock.calls[0][0] as NormalizeProfile).palette).toEqual([0xff0000ff]);
	});

	it('keeps the shipped palette and the keyed request without alpha', async () => {
		state.caps = { ...state.caps, transparency: false };
		await makeSingleAsset({ kind: 'sprite', prompt: 'a slime' });
		expect((state.effective.mock.calls[0][0] as NormalizeProfile).palette).toEqual([0x112233ff]);
		expect(state.generate.mock.calls[0][0].transparent).toBeFalsy();
	});

	it('asks for a texture to tile', async () => {
		await makeSingleAsset({ kind: 'texture', prompt: 'mossy cobblestones' });
		expect(state.generate.mock.calls[0][0].seamless).toBe(true);
	});

	it('tries again when the checks fail, and keeps the better of the two', async () => {
		state.check
			.mockResolvedValueOnce({ passed: false, failed: ['a', 'b'] })
			.mockResolvedValueOnce({ passed: false, failed: ['a'] });
		state.generate.mockResolvedValueOnce(drawn([], 1)).mockResolvedValueOnce(drawn([], 2));
		const out = await makeSingleAsset({ kind: 'sprite', prompt: 'a slime' });
		expect(state.generate).toHaveBeenCalledTimes(2);
		expect(out.seed).toBe(2);
		expect(out.checks.failed).toEqual(['a']);
	});

	it('does not hold a texture that could not tile to the seam check', async () => {
		state.generate.mockResolvedValue(drawn(['It does not tile: vae encode failed']));
		await makeSingleAsset({ kind: 'texture', prompt: 'bricks' });
		// The plain profile, not the one carrying the texture seam limit.
		expect(state.check.mock.calls[0][1].checks.seam_max).toBeUndefined();
		state.generate.mockResolvedValue(drawn());
		await makeSingleAsset({ kind: 'texture', prompt: 'bricks' });
		expect(state.check.mock.calls[1][1].checks.seam_max).toBeDefined();
	});

	it('draws a plain picture at a size the model can draw, without normalising it', async () => {
		await makeSingleAsset({ kind: 'image', prompt: 'a lighthouse', size: 64 });
		expect(state.generate.mock.calls[0][0]).toMatchObject({ width: 512, height: 512 });
		expect(state.normalize).not.toHaveBeenCalled();
	});
});

describe('pngSize', () => {
	it('reads the header, and refuses what is not a PNG', () => {
		expect(pngSize(png(48, 16))).toEqual({ width: 48, height: 16 });
		expect(pngSize(new Uint8Array(30))).toBeNull();
	});
});
