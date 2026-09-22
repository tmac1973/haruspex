import { describe, it, expect } from 'vitest';
import {
	buildEntryRequest,
	entryEdge,
	entryNegativePrompt,
	entryPrompt,
	wantsIsolation,
	ISOLATION_NEGATIVE
} from './request';
import type { AssetEntry, AssetSpec, NormalizeProfile } from '$lib/assets/spec/types';
import type { ImageBackendCapabilities } from '$lib/image/types';

function profile(over: Partial<NormalizeProfile> = {}): NormalizeProfile {
	return {
		target_size: 32,
		upscale: 16,
		palette_size: 16,
		palette: [],
		background: {
			color: 0xff00ffff,
			tolerance: 40,
			hue_tolerance_deg: 20,
			min_saturation: 90,
			min_value: 60,
			auto_detect: true
		},
		crop: { enabled: true, margin: 1, min_island_fraction: 0.05 },
		outline: { enabled: true, color: 0x1a1a1aff, width: 2 },
		reference_strength: 0.6,
		checks: { alpha_min: 0.05, alpha_max: 0.95, entropy_min: 1, palette_distance_max: 0.15 },
		by_kind: {},
		...over
	} as NormalizeProfile;
}

function entry(over: Partial<AssetEntry> = {}): AssetEntry {
	return { id: 'e', kind: 'sprite', prompt: 'a sword', out: 'a/e.png', ...over };
}

function spec(over: Partial<AssetSpec> = {}): AssetSpec {
	return {
		version: 1,
		style: { prompt: 'flat pixel art' },
		anchor: { image: 'a/anchor.png', recipe: 'a/anchor.json' },
		normalize: profile(),
		entries: [],
		...over
	} as AssetSpec;
}

const FULL: ImageBackendCapabilities = {
	referenceConditioning: true,
	seamlessTiling: true,
	loras: true,
	maxLoras: 2
};

const ANCHOR = new Uint8Array([1, 2, 3]);
const OPTS = { anchor: ANCHOR, maxEdge: 1024 };

describe('the isolation scaffold', () => {
	it('wraps a sprite and an icon', () => {
		// Without it SD1.5 composes a full frame, there is no background to
		// remove, and every sprite fails its alpha check fully opaque.
		for (const kind of ['sprite', 'icon'] as const) {
			expect(wantsIsolation(kind)).toBe(true);
			const p = entryPrompt(entry({ kind }), spec(), profile());
			expect(p).toContain('one object only');
			expect(p).toContain('lots of empty');
		}
	});

	it('is absent from a texture, which is meant to fill its frame', () => {
		expect(wantsIsolation('texture')).toBe(false);
		const p = entryPrompt(entry({ kind: 'texture', prompt: 'cobblestone' }), spec(), profile());
		expect(p).not.toContain('one object only');
		expect(p).not.toContain('empty');
		expect(p).toContain('cobblestone');
	});

	it('names the colour the profile will actually key against', () => {
		// The prompt and the chroma key have one source. If they can name
		// different colours the background survives into every asset.
		const p = entryPrompt(
			entry(),
			spec(),
			profile({ background: { ...profile().background, color: 0x00ff00ff } })
		);
		expect(p).toContain('#00ff00');
		expect(p).not.toContain('#ff00ff');
	});

	it('leaves the style prompt with the last word', () => {
		const p = entryPrompt(entry(), spec(), profile());
		expect(p.indexOf('flat pixel art')).toBeGreaterThan(p.indexOf('one object only'));
	});

	it('adds its negative for a sprite and not for a texture', () => {
		expect(entryNegativePrompt(entry(), spec())).toContain(ISOLATION_NEGATIVE);
		expect(entryNegativePrompt(entry({ kind: 'texture' }), spec())).not.toContain(
			'multiple objects'
		);
	});

	it('keeps the entry negative ahead of the scaffold and the style', () => {
		const n = entryNegativePrompt(
			entry({ negativePrompt: 'no rust' }),
			spec({ style: { prompt: 'x', negativePrompt: 'no gore' } })
		);
		expect(n.indexOf('no rust')).toBeLessThan(n.indexOf('multiple objects'));
		expect(n.indexOf('multiple objects')).toBeLessThan(n.indexOf('no gore'));
	});
});

describe('entryEdge', () => {
	it('is the target size at generation resolution', () => {
		expect(entryEdge(entry(), profile({ target_size: 32, upscale: 8 }), 4096)).toBe(256);
	});

	it('lets one entry override the target size', () => {
		expect(entryEdge(entry({ size: 64 }), profile({ upscale: 8 }), 4096)).toBe(512);
	});

	it('clamps an oversized entry rather than letting it ask for the moon', () => {
		expect(entryEdge(entry({ size: 512 }), profile({ upscale: 16 }), 1024)).toBe(1024);
	});
});

describe('buildEntryRequest with a fully capable backend', () => {
	it('attaches the anchor at the profile strength', () => {
		const { request, degraded } = buildEntryRequest(entry(), spec(), profile(), FULL, OPTS);
		expect(request.referenceImage).toBe(ANCHOR);
		expect(request.referenceStrength).toBe(0.6);
		expect(degraded).toEqual([]);
	});

	it('asks for seamless on a texture and not on a sprite', () => {
		expect(
			buildEntryRequest(entry({ kind: 'texture' }), spec(), profile(), FULL, OPTS).request.seamless
		).toBe(true);
		expect(
			buildEntryRequest(entry(), spec(), profile(), FULL, OPTS).request.seamless
		).toBeUndefined();
	});

	it('honours an explicit seamless flag against the kind default', () => {
		expect(
			buildEntryRequest(entry({ kind: 'texture', seamless: false }), spec(), profile(), FULL, OPTS)
				.request.seamless
		).toBeUndefined();
		expect(
			buildEntryRequest(entry({ seamless: true }), spec(), profile(), FULL, OPTS).request.seamless
		).toBe(true);
	});

	it('carries the pinned model and the entry seed', () => {
		const { request } = buildEntryRequest(
			entry({ seed: 7 }),
			spec({ style: { prompt: 'x', model: 'pinned.safetensors' } }),
			profile(),
			FULL,
			OPTS
		);
		expect(request.model).toBe('pinned.safetensors');
		expect(request.seed).toBe(7);
	});

	it('sends seed null when the entry does not pin one', () => {
		expect(buildEntryRequest(entry(), spec(), profile(), FULL, OPTS).request.seed).toBeNull();
	});
});

describe('degradation', () => {
	it('drops the reference and says so when the backend cannot condition', () => {
		const caps = { ...FULL, referenceConditioning: false };
		const { request, degraded } = buildEntryRequest(entry(), spec(), profile(), caps, OPTS);
		expect(request.referenceImage).toBeUndefined();
		expect(request.referenceStrength).toBeUndefined();
		expect(degraded).toContain('no reference conditioning');
	});

	it('generates a texture anyway when the backend cannot tile, and records it', () => {
		// A visible seam beats a missing texture; the report says which it is.
		const caps = { ...FULL, seamlessTiling: false };
		const { request, degraded } = buildEntryRequest(
			entry({ kind: 'texture' }),
			spec(),
			profile(),
			caps,
			OPTS
		);
		expect(request.seamless).toBeUndefined();
		expect(degraded).toContain('not seamless');
	});

	it('does not claim a sprite was degraded by a backend that cannot tile', () => {
		const caps = { ...FULL, seamlessTiling: false };
		expect(buildEntryRequest(entry(), spec(), profile(), caps, OPTS).degraded).toEqual([]);
	});

	it('drops the excess LoRAs and names the count', () => {
		const loras = [
			{ name: 'a', strength: 1 },
			{ name: 'b', strength: 1 }
		];
		const caps = { ...FULL, maxLoras: 1 };
		const { request, degraded } = buildEntryRequest(
			entry(),
			spec({ style: { prompt: 'x', loras } }),
			profile(),
			caps,
			OPTS
		);
		expect(request.loras).toEqual([loras[0]]);
		expect(degraded).toEqual(['1 of 2 LoRAs dropped']);
	});

	it('drops all of them when the backend has no LoRA support', () => {
		const caps = { ...FULL, loras: false, maxLoras: 0 };
		const { request, degraded } = buildEntryRequest(
			entry(),
			spec({ style: { prompt: 'x', loras: [{ name: 'a', strength: 1 }] } }),
			profile(),
			caps,
			OPTS
		);
		expect(request.loras).toBeUndefined();
		expect(degraded).toEqual(['no LoRA support — 1 dropped']);
	});

	it('records nothing when no LoRAs were asked for', () => {
		const caps = { ...FULL, loras: false, maxLoras: 0 };
		expect(buildEntryRequest(entry(), spec(), profile(), caps, OPTS).degraded).toEqual([]);
	});

	it('records nothing about conditioning when there is no anchor to attach', () => {
		const caps = { ...FULL, referenceConditioning: false };
		const { degraded } = buildEntryRequest(entry(), spec(), profile(), caps, {
			anchor: null,
			maxEdge: 1024
		});
		expect(degraded).toEqual([]);
	});
});
