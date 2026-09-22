import { describe, it, expect } from 'vitest';
import {
	hexColor,
	colourWord,
	anchorSubjects,
	anchorPrompt,
	anchorNegativePrompt,
	anchorEdge,
	specSummary
} from './anchor';
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

describe('colourWord', () => {
	it('names the key colours a chroma key is actually set to', () => {
		// Measured against SD1.5: a prompt saying "#ff00ff" produces no magenta
		// at all, and the request for a flat backdrop is silently lost. The same
		// prompt saying "magenta" produces a flat field the key removes cleanly.
		expect(colourWord(0xff00ffff)).toBe('magenta');
		expect(colourWord(0x00ff00ff)).toBe('bright green');
		expect(colourWord(0x000000ff)).toBe('black');
	});

	it('snaps a near-miss to the nearest word rather than inventing one', () => {
		expect(colourWord(0xfa05f0ff)).toBe('magenta');
	});
});

describe('anchorPrompt', () => {
	it('leads with the style, because whatever opens the prompt picks the medium', () => {
		// Paid for in bad generations: subjects-first, style-appended produced a
		// competent OIL PAINTING of a chair; style-first produced pixel art of
		// the same subjects. The medium is the entire point of a style anchor.
		const p = anchorPrompt(spec(), profile());
		expect(p.startsWith('flat pixel art, muted palette')).toBe(true);
	});

	it('never says "reference sheet" or "grid"', () => {
		// That phrasing produced a flat brown floor plan — abstract rectangles,
		// no subject at all — twice out of two. The model reads "sheet" and
		// "grid" as the picture's content.
		const p = anchorPrompt(spec(), profile()).toLowerCase();
		expect(p).not.toContain('reference sheet');
		expect(p).not.toContain('grid');
		expect(p).not.toContain('2x2');
	});

	it('asks for no ground or terrain among the subjects', () => {
		// "a patch of ground" made the model render the whole background as
		// grass, destroying the flat backdrop the chroma key depends on.
		const p = anchorPrompt(spec(), profile()).toLowerCase();
		// Word boundaries: "background" legitimately contains "ground".
		for (const word of ['ground', 'terrain', 'grass', 'floor']) {
			expect(p).not.toMatch(new RegExp(`\\b${word}\\b`));
		}
	});

	it('names the background colour exactly once', () => {
		// Measured on SDXL at one seed: naming it twice tinted 30% of the
		// subjects' own pixels that colour, once tinted 12%. The palette is
		// made of the art's colours, so a backdrop said twice is how a whole
		// set comes out pink.
		const p = anchorPrompt(spec(), profile());
		expect(p.split('magenta')).toHaveLength(2);
	});

	it('names the background in a word, not in hex', () => {
		// The prompt and the chroma key have one source; a hex string the model
		// cannot read means the background survives into every asset.
		const p = anchorPrompt(
			spec(),
			profile({ background: { ...profile().background, color: 0x00ff00ff } })
		);
		expect(p).toContain('bright green');
		expect(p).not.toContain('#');
	});

	it('trims a long style so the sheet instruction survives the encoder window', () => {
		// The failure this prevents: a 637-character style pushed the anchor's
		// own composition instruction past CLIP's 77 tokens, and the model
		// rendered abstract blobs with none of the named subjects in them.
		const long =
			'16-bit era top-down pixel art for a roguelike, 32x32 pixel scale, crisp chunky pixels ' +
			'with hard pixel edges, strictly no anti-aliasing; near-orthogonal top-down view with a ' +
			'slight 3/4 tilt; desaturated post-apocalyptic palette of ash grey, rust orange-brown, ' +
			'faded olive drab, dusty beige and oxidised teal; bold near-black 1px outline on every ' +
			'silhouette; flat limited shading of two or three tones per surface; overhead daylight';
		const p = anchorPrompt(spec({ style: { prompt: long } }), profile());
		// The style's tail is gone…
		expect(p).not.toContain('overhead daylight');
		// …and what the prompt exists to say is still in there.
		expect(p).toContain('sprite sheet');
		expect(p).toContain('magenta');
		expect(p.startsWith('16-bit era top-down pixel art')).toBe(true);
	});

	it('asks for isolated subjects', () => {
		expect(anchorPrompt(spec(), profile()).toLowerCase()).toContain('isolated');
	});

	it('shows the spec\u2019s own subjects, so the palette covers them', () => {
		// The failure that produced nothing: a generic sheet in a muted earthy
		// style has no grey for an iron sword and no red for a health potion,
		// so every asset measures as wildly off-style against a palette that
		// never contained its colours.
		const p = anchorPrompt(
			spec({
				entries: [
					{ id: 'a', kind: 'sprite', prompt: 'an iron sword', out: 'a.png' },
					{ id: 'b', kind: 'icon', prompt: 'a gold coin', out: 'b.png' }
				]
			} as Partial<AssetSpec>),
			profile()
		);
		expect(p).toContain('an iron sword');
		expect(p).toContain('a gold coin');
	});
});

describe('anchorSubjects', () => {
	function entries(list: Array<[string, string]>) {
		return list.map(([kind, prompt], i) => ({
			id: `e${i}`,
			kind,
			prompt,
			out: `o${i}.png`
		}));
	}

	it('samples across kinds rather than taking the first four', () => {
		// A spec of forty swords and one coin must not produce a sheet of four
		// swords — the coin's colours would never reach the palette.
		const subjects = anchorSubjects(
			spec({
				entries: entries([
					['sprite', 'sword one'],
					['sprite', 'sword two'],
					['sprite', 'sword three'],
					['sprite', 'sword four'],
					['icon', 'a gold coin']
				])
			} as Partial<AssetSpec>)
		);
		expect(subjects).toContain('a gold coin');
	});

	it('leaves textures out, because naming one fills the whole frame with it', () => {
		const subjects = anchorSubjects(
			spec({
				entries: entries([
					['sprite', 'an iron sword'],
					['texture', 'grey cobblestone floor']
				])
			} as Partial<AssetSpec>)
		);
		expect(subjects).toContain('an iron sword');
		expect(subjects).not.toContain('cobblestone');
	});

	it('falls back to a generic list when the spec is all textures', () => {
		// Better a generic anchor than one that sabotages its own backdrop.
		const subjects = anchorSubjects(
			spec({ entries: entries([['texture', 'cobblestone']]) } as Partial<AssetSpec>)
		);
		expect(subjects).toContain('a character');
		expect(subjects).not.toContain('cobblestone');
	});

	it('takes the subject, not the whole entry prompt', () => {
		// An entry prompt says everything ONE image needs. Four of them joined
		// ran the anchor to 140 tokens, past CLIP's 77, and the composition
		// instruction that comes last fell out of the window: the sheet came
		// back as a single character filling the frame, no isolation and no
		// key colour.
		const subjects = anchorSubjects(
			spec({
				entries: [
					{
						id: 'a',
						kind: 'sprite',
						prompt:
							'lone scavenger survivor in patched duster coat and respirator, ' +
							'seen top-down from directly above facing down',
						out: 'a.png'
					}
				]
			} as Partial<AssetSpec>)
		);
		expect(subjects.length).toBeLessThanOrEqual(40);
		expect(subjects.startsWith('lone scavenger survivor')).toBe(true);
		expect(subjects).not.toContain('top-down');
	});

	it('shortens a long subject that has no clause break', () => {
		const subjects = anchorSubjects(
			spec({
				entries: [{ id: 'a', kind: 'sprite', prompt: 'x'.repeat(200), out: 'a.png' }]
			} as Partial<AssetSpec>)
		);
		expect(subjects.length).toBeLessThanOrEqual(40);
	});

	it('keeps the whole anchor prompt inside the encoder window', () => {
		// Four long entry prompts plus the frame is what blew it. The guard is
		// on the result, not on any one part, because each part was individually
		// reasonable.
		const long = (n: number) =>
			`subject ${n} with a great many descriptive words about it, seen from directly above`;
		const p = anchorPrompt(
			spec({
				entries: [0, 1, 2, 3, 4, 5].map((n) => ({
					id: `e${n}`,
					kind: 'sprite',
					prompt: long(n),
					out: `e${n}.png`
				}))
			} as Partial<AssetSpec>),
			profile()
		);
		// ~3.7 characters per CLIP token. 100 is measured-working; the failure
		// that prompted this was 140.
		expect(p.length / 3.7).toBeLessThan(100);
	});

	it('never asks for more subjects than a sheet can show', () => {
		const many = entries(Array.from({ length: 20 }, (_, i) => ['sprite', `thing ${i}`]));
		const subjects = anchorSubjects(spec({ entries: many } as Partial<AssetSpec>));
		expect(subjects.split(', ')).toHaveLength(4);
	});
});

describe('anchorNegativePrompt', () => {
	it('joins the style negative with the anchor-specific one', () => {
		const n = anchorNegativePrompt(spec({ style: { prompt: 'x', negativePrompt: 'blurry' } }));
		expect(n).toContain('blurry');
		expect(n).toContain('busy background');
	});

	it('names the abstractions that "sheet" pulls toward', () => {
		// Removing the words from the positive prompt is not enough on its own;
		// the model still drifts to floor plans and blueprints.
		const n = anchorNegativePrompt(spec());
		for (const word of ['grid', 'floor plan', 'blueprint', 'abstract']) {
			expect(n).toContain(word);
		}
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
