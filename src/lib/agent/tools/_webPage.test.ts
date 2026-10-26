import { describe, expect, it } from 'vitest';
import {
	cutPage,
	fetchCutNote,
	fetchUrlBudget,
	researchBudget,
	researchNote
} from '#lib/agent/tools/_webPage.ts';

const remote = (contextSize: number) => ({ baseUrl: 'http://m.test', modelId: 'm', contextSize });

describe('page budgets', () => {
	it('grow with the context window, within limits', () => {
		expect(fetchUrlBudget(remote(8_192))).toBe(8_000);
		expect(fetchUrlBudget(remote(32_768))).toBe(9_830);
		expect(fetchUrlBudget(remote(262_144))).toBe(48_000);
		expect(researchBudget(3_072, remote(32_768))).toBe(64_566);
		expect(researchBudget(3_072, remote(262_144))).toBe(200_000);
		expect(researchBudget(3_072, remote(4_096))).toBe(12_000);
	});
});

describe('cutPage', () => {
	it('keeps a page that fits', () => {
		const c = cutPage({ text: 'short page', full_length: 10, hero_image: null }, 100);
		expect(c).toEqual({ text: 'short page', shown: 10, full: 10 });
		expect(fetchCutNote(c)).toBe('');
	});

	it('cuts at a word and says how much is shown', () => {
		const text = 'alpha beta gamma delta epsilon';
		const c = cutPage({ text, full_length: text.length, hero_image: null }, 20);
		expect(c.text).toBe('alpha beta gamma');
		expect(fetchCutNote(c)).toContain('first 16 of 30 characters');
		expect(fetchCutNote(c)).toContain('research_url');
	});

	it('counts what Rust cut before it arrived', () => {
		const c = cutPage({ text: 'x'.repeat(50), full_length: 900_000, hero_image: null }, 100);
		expect(c.full).toBe(900_000);
		expect(researchNote(c, false)).toContain('first 50 of 900,000');
	});
});

describe('researchNote', () => {
	it('says nothing when the whole page was read and something was found', () => {
		const c = cutPage({ text: 'x'.repeat(5_000), full_length: 5_000, hero_image: null }, 10_000);
		expect(researchNote(c, false)).toBe('');
	});

	it('flags a thin page as likely built by JavaScript when nothing was found', () => {
		const c = cutPage({ text: 'Loading…', full_length: 8, hero_image: null }, 10_000);
		expect(researchNote(c, true)).toMatch(/only 8 characters.*JavaScript/);
	});

	it('says the answer may be in the unread part when nothing was found in a cut page', () => {
		const c = cutPage({ text: 'y '.repeat(10_000), full_length: 20_000, hero_image: null }, 2_000);
		expect(researchNote(c, true)).toMatch(/Read the first .* may be in the part not read/);
	});
});
