import { describe, it, expect } from 'vitest';
import {
	MAX_REWRITES,
	mayRewrite,
	notePreview,
	noteRewrite,
	previewText,
	rewritesLeft
} from './preview';

describe('mayRewrite', () => {
	const titles = ['Intro', 'Numbers', 'Plan', 'End'];

	it('is false for a deck that was never previewed', () => {
		expect(mayRewrite(new Set(), 'd.pptx', titles)).toBe(false);
	});

	it('allows a deck that keeps at least half its titles, ignoring case and spaces', () => {
		const turn = new Set<string>();
		notePreview(turn, 'd.pptx', titles);
		expect(mayRewrite(turn, 'd.pptx', [' intro ', 'NUMBERS', 'New one', 'Another'])).toBe(true);
		expect(mayRewrite(turn, 'd.pptx', ['Intro', 'Something', 'Else', 'Entirely'])).toBe(false);
		expect(mayRewrite(turn, 'other.pptx', titles)).toBe(false);
	});

	it('keeps each turn apart', () => {
		const turn = new Set<string>();
		notePreview(turn, 'd.pptx', titles);
		expect(mayRewrite(new Set(), 'd.pptx', titles)).toBe(false);
	});

	it('stops after the last rewrite, and a new preview doesn’t reset the count', () => {
		const turn = new Set<string>();
		notePreview(turn, 'd.pptx', titles);
		for (let i = 0; i < MAX_REWRITES; i++) {
			expect(mayRewrite(turn, 'd.pptx', titles)).toBe(true);
			noteRewrite(turn, 'd.pptx');
			notePreview(turn, 'd.pptx', titles);
		}
		expect(rewritesLeft(turn, 'd.pptx')).toBe(0);
		expect(mayRewrite(turn, 'd.pptx', titles)).toBe(false);
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
