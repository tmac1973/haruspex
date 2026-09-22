import { describe, it, expect } from 'vitest';
import { hexColor, anchorPrompt, anchorNegativePrompt, anchorEdge, specSummary } from './anchor';
import type { AssetSpec, NormalizeProfile } from '$lib/assets/spec/types';

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

function spec(over: Partial<AssetSpec> = {}): AssetSpec {
	return {
		version: 1,
		style: { prompt: 'flat pixel art, muted palette' },
		anchor: { image: 'a/anchor.png', recipe: 'a/anchor.json' },
		normalize: profile(),
		entries: [],
		...over
	} as AssetSpec;
}

describe('hexColor', () => {
	it('reads the packed RGBA the profile stores, dropping alpha', () => {
		expect(hexColor(0xff00ffff)).toBe('#ff00ff');
		expect(hexColor(0x1a1a1aff)).toBe('#1a1a1a');
		expect(hexColor(0x000000ff)).toBe('#000000');
	});
});

describe('anchorPrompt', () => {
	it('names the key colour the profile will actually key against', () => {
		// Not a constant. Asking for one colour and keying another is how the
		// background survives into every asset in the set.
		const p = anchorPrompt(
			spec(),
			profile({ background: { ...profile().background, color: 0x00ff00ff } })
		);
		expect(p).toContain('#00ff00');
	});

	it('carries the style prompt through, and asks for separated subjects', () => {
		const p = anchorPrompt(spec(), profile());
		expect(p).toContain('flat pixel art, muted palette');
		// The reference has to show the style across subject TYPES, which is
		// the whole reason it is one image of four things.
		expect(p).toContain('2x2');
		expect(p.toLowerCase()).toContain('separated');
	});
});

describe('anchorNegativePrompt', () => {
	it('joins the style negative with the anchor-specific one', () => {
		const n = anchorNegativePrompt(spec({ style: { prompt: 'x', negativePrompt: 'blurry' } }));
		expect(n).toContain('blurry');
		expect(n).toContain('busy background');
	});

	it('does not emit a leading comma when the style has no negative', () => {
		expect(anchorNegativePrompt(spec())).not.toMatch(/^,/);
	});
});

describe('anchorEdge', () => {
	it('is a 2x2 grid of generation-resolution cells', () => {
		expect(anchorEdge(profile({ target_size: 32, upscale: 8 }), 4096)).toBe(512);
	});

	it('clamps, because the default profile at 512 would otherwise ask for 16384', () => {
		// 512 * 16 * 2. The clamp is the only thing between the default
		// profile and an allocation no consumer GPU survives.
		expect(anchorEdge(profile({ target_size: 512, upscale: 16 }), 1024)).toBe(1024);
	});
});

describe('specSummary', () => {
	function entries(n: number, kind = 'sprite') {
		return Array.from({ length: n }, (_, i) => ({
			id: `e${i}`,
			kind,
			prompt: 'p',
			out: `o${i}.png`
		}));
	}

	it('counts by kind', () => {
		const s = specSummary(
			spec({ entries: [...entries(2, 'sprite'), ...entries(1, 'texture')] } as Partial<AssetSpec>)
		);
		expect(s).toContain('2 sprite');
		expect(s).toContain('1 texture');
	});

	it('truncates a long list rather than printing forty ids into a modal', () => {
		const s = specSummary(spec({ entries: entries(20) } as Partial<AssetSpec>));
		expect(s).toContain('and 12 more');
		expect(s).not.toContain('e19');
	});
});
