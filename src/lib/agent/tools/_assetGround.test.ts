import { describe, expect, it } from 'vitest';
import { greyOf, groundNote, spritesArg } from './_assetGround';

const tone = { lightness: 0.22, target: 0.47, targetGrey: 0x5c5c5cff };
const paths = ['sprites/knight.png', 'sprites/skeleton.png', 'sprites/bat.png'];

describe('groundNote', () => {
	it('says the sprites show up when none blends', () => {
		const c = {
			ground: 0.6,
			sprites: [0.22, 0.22, 0.37],
			blending: 0,
			blends: [false, false, false],
			ok: true,
			tone
		};
		expect(groundNote(c, paths)).toBe(
			'The sprites show up on it: its lightness is 0.60, theirs 0.22, 0.22, 0.37.'
		);
	});

	it('names a sprite that blends even when most show up', () => {
		// The live run: a bat at 0.37 on a 0.40 floor passed the job's majority rule.
		const c = {
			ground: 0.4,
			sprites: [0.22, 0.22, 0.37],
			blending: 1,
			blends: [false, false, true],
			ok: true,
			tone
		};
		const note = groundNote(c, paths);
		expect(note).toContain('hard to see on it: sprites/bat.png (0.37)');
		expect(note).toContain("against the tile's 0.40");
		expect(note).toContain('lighter than 0.47');
		expect(note).toContain('darker than 0.12');
		expect(note).toContain('overwrite: true');
	});

	it('counts rather than names when a sprite had nothing to measure', () => {
		const c = { ground: 0.4, sprites: [0.37], blending: 1, blends: [true], ok: false, tone };
		expect(groundNote(c, paths)).toContain('hard to see on it: 1 of the sprites');
	});
});

describe('greyOf', () => {
	it('turns a lightness into a grey', () => {
		expect(greyOf(0)).toBe('#000000');
		expect(greyOf(1)).toBe('#ffffff');
		expect(greyOf(0.5)).toBe('#636363');
	});
});

describe('spritesArg', () => {
	it('takes a list of paths, or one path', () => {
		expect(spritesArg(undefined)).toEqual([]);
		expect(spritesArg(' a.png ')).toEqual(['a.png']);
		expect(spritesArg(['a.png', 'b.png'])).toEqual(['a.png', 'b.png']);
		expect(spritesArg(['a.png', 3])).toMatch(/list of sprite file paths/);
		expect(spritesArg(Array(9).fill('a.png'))).toMatch(/at most 8/);
	});
});
