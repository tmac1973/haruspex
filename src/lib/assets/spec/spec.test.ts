import { describe, it, expect } from 'vitest';
import { parseAssetSpec } from './parse';
import { renderAssetSpec } from './write';
import { validateAssetSpec } from './validate';
import { defaultOutPath, slugify, uniqueId, DEFAULT_ANCHOR_IMAGE } from './paths';
import { joinNegativePrompts, type AssetSpec } from './types';
import type { NormalizeProfile } from '$lib/ipc/gen/NormalizeProfile';

/** A profile shaped like the Rust default; the spec only carries it. */
const profile = (): NormalizeProfile =>
	({
		target_size: 32,
		upscale: 16,
		palette_size: 16,
		palette: [],
		background: { color: 0xff00ffff, tolerance: 40, auto_detect: true },
		crop: { enabled: true, margin: 1 },
		outline: { enabled: true, color: 0x1a1a1aff, width: 2 },
		reference_strength: 0.6,
		checks: { alpha_min: 0.05, alpha_max: 0.95, entropy_min: 1.0, palette_distance_max: 0.15 },
		by_kind: {}
	}) as unknown as NormalizeProfile;

function spec(over: Partial<AssetSpec> = {}): AssetSpec {
	return {
		version: 1,
		style: { prompt: 'flat pixel art, dark outline' },
		anchor: { image: 'assets/haruspex-anchor.png', recipe: 'assets/haruspex-anchor.json' },
		normalize: profile(),
		entries: [
			{ id: 'iron_sword', kind: 'sprite', prompt: 'an iron sword', out: 'a/sword.png' },
			{ id: 'cobble', kind: 'texture', prompt: 'cobblestones', out: 'a/cobble.png', seamless: true }
		],
		...over
	};
}

function ok(json: string): AssetSpec {
	const r = parseAssetSpec(json);
	if ('errors' in r) throw new Error(r.errors.join('; '));
	return r.spec;
}

describe('parse', () => {
	it('reads a minimal spec', () => {
		const s = ok(renderAssetSpec(spec()));
		expect(s.entries).toHaveLength(2);
		expect(s.style.prompt).toBe('flat pixel art, dark outline');
	});

	it('reports malformed JSON rather than throwing', () => {
		const r = parseAssetSpec('{ not json');
		expect('errors' in r && r.errors[0]).toMatch(/not valid JSON/);
	});

	it('reports a missing entries array', () => {
		const r = parseAssetSpec('{"normalize":{}}');
		expect('errors' in r && r.errors[0]).toMatch(/no "entries"/);
	});

	it('reports a missing normalize profile', () => {
		const r = parseAssetSpec('{"entries":[]}');
		expect('errors' in r && r.errors[0]).toMatch(/no "normalize"/);
	});

	it('defaults the anchor paths when the file omits them', () => {
		// Phase 08 reads these; a spec written before they existed must still
		// point somewhere rather than at the empty string.
		const s = ok('{"entries":[],"normalize":{}}');
		expect(s.anchor.image).toBe(DEFAULT_ANCHOR_IMAGE);
	});

	it('makes a texture seamless unless it says otherwise', () => {
		const s = ok(
			'{"entries":[{"id":"x","kind":"texture","prompt":"p","out":"o.png"}],"normalize":{}}'
		);
		expect(s.entries[0].seamless).toBe(true);
	});

	it('leaves a sprite alone', () => {
		const s = ok(
			'{"entries":[{"id":"x","kind":"sprite","prompt":"p","out":"o.png"}],"normalize":{}}'
		);
		expect(s.entries[0].seamless).toBeUndefined();
	});

	it('falls back to sprite for an unrecognised kind', () => {
		const s = ok(
			'{"entries":[{"id":"x","kind":"hologram","prompt":"p","out":"o.png"}],"normalize":{}}'
		);
		expect(s.entries[0].kind).toBe('sprite');
	});

	it('keeps style model and loras, the only source either has', () => {
		const s = ok(
			renderAssetSpec(
				spec({
					style: {
						prompt: 'p',
						model: 'sdxl.safetensors',
						loras: [{ name: 'pixel', strength: 0.8 }]
					}
				})
			)
		);
		expect(s.style.model).toBe('sdxl.safetensors');
		expect(s.style.loras).toEqual([{ name: 'pixel', strength: 0.8 }]);
	});

	it('drops a nameless lora rather than passing an empty name through', () => {
		const s = ok('{"entries":[],"normalize":{},"style":{"prompt":"p","loras":[{"strength":1}]}}');
		expect(s.style.loras).toBeUndefined();
	});
});

describe('round trip', () => {
	it('parse(render(x)) equals x', () => {
		const original = spec();
		expect(ok(renderAssetSpec(original))).toEqual(original);
	});

	it('round-trips every optional field', () => {
		const original = spec({
			style: {
				prompt: 'p',
				negativePrompt: 'blurry',
				model: 'm',
				loras: [{ name: 'l', strength: 1 }]
			},
			entries: [
				{
					id: 'full',
					kind: 'icon',
					prompt: 'p',
					out: 'o.png',
					size: 64,
					seamless: false,
					seed: 7,
					negativePrompt: 'n',
					notes: 'for the shop screen'
				}
			]
		});
		expect(ok(renderAssetSpec(original))).toEqual(original);
	});

	it('keeps keys it does not recognise', () => {
		// A job rewrites this file; a user's own annotations must survive it.
		const json = renderAssetSpec(spec({ unknown: { $comment: 'mine', team: ['a'] } }));
		const back = ok(json);
		expect(back.unknown).toEqual({ $comment: 'mine', team: ['a'] });
		expect(renderAssetSpec(back)).toContain('"$comment"');
	});

	it('is byte-stable across two renders', () => {
		const s = spec();
		expect(renderAssetSpec(s)).toBe(renderAssetSpec(s));
	});

	it('writes no nulls for absent optional fields', () => {
		// `"size": null` would parse back as absent and break the round trip,
		// and reads as a decision somebody made.
		expect(renderAssetSpec(spec())).not.toContain('null');
	});
});

describe('validate', () => {
	const problems = (over: Partial<AssetSpec>) => validateAssetSpec(spec(over)).join(' | ');

	it('accepts a good spec', () => {
		expect(validateAssetSpec(spec())).toEqual([]);
	});

	it('names the offending entry in every message', () => {
		const p = problems({
			entries: [{ id: 'bad_one', kind: 'sprite', prompt: '', out: 'x.png' }]
		});
		expect(p).toContain('bad_one');
	});

	it('rejects an id that is not filename-safe', () => {
		for (const id of ['Sword', '1sword', 'iron sword', 'a', 'x'.repeat(49), 'iron-sword']) {
			expect(problems({ entries: [{ id, kind: 'sprite', prompt: 'p', out: 'o.png' }] })).toMatch(
				/id must start/
			);
		}
	});

	it('rejects duplicate ids', () => {
		expect(
			problems({
				entries: [
					{ id: 'same', kind: 'sprite', prompt: 'p', out: 'a.png' },
					{ id: 'same', kind: 'sprite', prompt: 'p', out: 'b.png' }
				]
			})
		).toMatch(/duplicate id/);
	});

	it('rejects an empty prompt', () => {
		expect(
			problems({ entries: [{ id: 'x_y', kind: 'sprite', prompt: '  ', out: 'o.png' }] })
		).toMatch(/empty prompt/);
	});

	it('rejects an output path that escapes the working directory', () => {
		// The security-relevant one. Windows spellings included, because a
		// check that passes on Linux and fails on Windows is the classic
		// version of this bug.
		for (const out of ['../evil.png', '/etc/passwd', 'C:\\windows\\evil.png', 'a/../../b.png']) {
			expect(problems({ entries: [{ id: 'x_y', kind: 'sprite', prompt: 'p', out }] })).toMatch(
				/outside the working directory/
			);
		}
	});

	it('allows a path that merely contains two dots', () => {
		expect(
			validateAssetSpec(
				spec({ entries: [{ id: 'x_y', kind: 'sprite', prompt: 'p', out: 'a/my..thing.png' }] })
			)
		).toEqual([]);
	});

	it('rejects two entries writing to the same file', () => {
		expect(
			problems({
				entries: [
					{ id: 'one_a', kind: 'sprite', prompt: 'p', out: 'same.png' },
					{ id: 'two_b', kind: 'sprite', prompt: 'p', out: 'same.png' }
				]
			})
		).toMatch(/one_a also writes to/);
	});

	it('rejects a size that is not a positive power of two', () => {
		for (const size of [30, 0, -32, 33, 1.5]) {
			expect(
				problems({ entries: [{ id: 'x_y', kind: 'sprite', prompt: 'p', out: 'o.png', size }] })
			).toMatch(/not a positive power of two/);
		}
	});

	it('rejects a texture that says it does not tile', () => {
		expect(
			problems({
				entries: [{ id: 'x_y', kind: 'texture', prompt: 'p', out: 'o.png', seamless: false }]
			})
		).toMatch(/will not tile/);
	});

	it('rejects a spec with no entries and no style prompt', () => {
		const p = validateAssetSpec(spec({ entries: [], style: { prompt: '' } }));
		expect(p).toHaveLength(2);
	});

	it('collects every problem rather than stopping at the first', () => {
		const p = validateAssetSpec(
			spec({
				entries: [
					{ id: 'BAD', kind: 'sprite', prompt: '', out: '../x.png' },
					{ id: 'BAD', kind: 'sprite', prompt: 'p', out: '../x.png' }
				]
			})
		);
		expect(p.length).toBeGreaterThan(4);
	});
});

describe('paths and ids', () => {
	it('puts a derived entry under its kind', () => {
		expect(defaultOutPath('texture', 'cobble')).toBe('assets/generated/texture/cobble.png');
	});

	it('slugifies a title into a legal id', () => {
		expect(slugify('Iron Sword (rusty)')).toBe('iron_sword_rusty');
		expect(slugify('  spaced  out  ')).toBe('spaced_out');
	});

	it('prefixes a title that would not start with a letter', () => {
		expect(slugify('2 handed axe')).toBe('a_2_handed_axe');
		expect(slugify('!!!')).toBe('asset');
	});

	it('truncates to the id limit', () => {
		expect(slugify('x'.repeat(80))).toHaveLength(48);
	});

	it('de-duplicates ids that slugify identically', () => {
		const taken = new Set<string>();
		const ids = ['Iron Sword', 'iron sword', 'IRON  SWORD'].map((t) => {
			const id = uniqueId(t, taken);
			taken.add(id);
			return id;
		});
		expect(ids).toEqual(['iron_sword', 'iron_sword_2', 'iron_sword_3']);
	});

	it('keeps a de-duplicated id inside the length limit', () => {
		const taken = new Set([slugify('x'.repeat(80))]);
		const id = uniqueId('x'.repeat(80), taken);
		expect(id.length).toBeLessThanOrEqual(48);
		expect(id).toMatch(/^[a-z][a-z0-9_]{1,47}$/);
	});
});

describe('joinNegativePrompts', () => {
	it('puts the entry first, as the more specific of the two', () => {
		expect(joinNegativePrompts('no hilt', 'blurry')).toBe('no hilt, blurry');
	});

	it('uses whichever one exists', () => {
		expect(joinNegativePrompts(undefined, 'blurry')).toBe('blurry');
		expect(joinNegativePrompts('no hilt', undefined)).toBe('no hilt');
		expect(joinNegativePrompts('  ', '')).toBe('');
	});
});
