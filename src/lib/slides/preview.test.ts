import { describe, it, expect } from 'vitest';
import {
	MAX_REWRITES,
	deckLook,
	mayRewrite,
	notePreview,
	noteRewrite,
	previewText,
	writtenLook,
	rewritesLeft,
	type DeckLook
} from './preview';

const look: DeckLook = { theme: 'dark', orientation: 'portrait' };

describe('mayRewrite', () => {
	const titles = ['Intro', 'Numbers', 'Plan', 'End'];

	it('is false for a deck that was never previewed', () => {
		expect(mayRewrite(new Set(), 'd.pptx', titles)).toBe(false);
	});

	it('allows a deck that keeps at least half its titles, ignoring case and spaces', () => {
		const turn = new Set<string>();
		notePreview(turn, 'd.pptx', titles, look);
		expect(mayRewrite(turn, 'd.pptx', [' intro ', 'NUMBERS', 'New one', 'Another'])).toBe(true);
		expect(mayRewrite(turn, 'd.pptx', ['Intro', 'Something', 'Else', 'Entirely'])).toBe(false);
		expect(mayRewrite(turn, 'other.pptx', titles)).toBe(false);
	});

	it('keeps each turn apart', () => {
		const turn = new Set<string>();
		notePreview(turn, 'd.pptx', titles, look);
		expect(mayRewrite(new Set(), 'd.pptx', titles)).toBe(false);
	});

	it('stops after the last rewrite, and a new preview doesn’t reset the count', () => {
		const turn = new Set<string>();
		notePreview(turn, 'd.pptx', titles, look);
		for (let i = 0; i < MAX_REWRITES; i++) {
			expect(mayRewrite(turn, 'd.pptx', titles)).toBe(true);
			noteRewrite(turn, 'd.pptx');
			notePreview(turn, 'd.pptx', titles, look);
		}
		expect(rewritesLeft(turn, 'd.pptx')).toBe(0);
		expect(mayRewrite(turn, 'd.pptx', titles)).toBe(false);
	});
});

describe('deckLook', () => {
	it('takes what the arguments name, light and landscape when they name nothing', () => {
		expect(deckLook({ theme: 'Warm', orientation: 'portrait' })).toEqual({
			theme: 'warm',
			orientation: 'portrait'
		});
		expect(deckLook({})).toEqual({ theme: 'light', orientation: 'landscape' });
	});

	it('keeps a previewed deck’s look where a rewrite leaves it out', () => {
		expect(deckLook({}, look)).toEqual(look);
		expect(deckLook({ theme: ' ' }, look)).toEqual(look);
		expect(deckLook({ theme: 'bold' }, look)).toEqual({ theme: 'bold', orientation: 'portrait' });
		expect(deckLook({ orientation: 'landscape' }, look)).toEqual({
			theme: 'dark',
			orientation: 'landscape'
		});
	});

	it('remembers the look of the deck previewed at a path', () => {
		const turn = new Set<string>();
		expect(writtenLook(turn, 'd.pptx')).toBeUndefined();
		notePreview(turn, 'd.pptx', ['A'], look);
		expect(writtenLook(turn, 'd.pptx')).toEqual(look);
	});
});

describe('previewText', () => {
	it('says how much of the deck the sheets show', () => {
		expect(previewText({ sheets: [], shown: 6, total: 6 }, 'd.pptx', true)).toMatch(
			/The sheets show all 6 slides/
		);
		expect(previewText({ sheets: [], shown: 18, total: 25 }, 'd.pptx', true)).toMatch(
			/The sheets show slides 1–18 of 25/
		);
	});

	it('offers a rewrite only while one is left', () => {
		const preview = { sheets: [], shown: 3, total: 3 };
		expect(previewText(preview, 'a/d.pptx', true)).toMatch(
			/write the whole deck again to "a\/d\.pptx"/
		);
		const spent = previewText(preview, 'a/d.pptx', false);
		expect(spent).not.toMatch(/write the whole deck again/);
		expect(spent).toMatch(/tell the user what still needs fixing/);
	});
});
