import { describe, expect, it } from 'vitest';
import {
	cutPage,
	fetchCutNote,
	fetchLinks,
	fetchUrlBudget,
	researchBudget,
	researchLinks,
	researchNote,
	selectJsonFields
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
		// fetch_url gets the same text, so it is not offered as the way round.
		expect(researchNote(c, true)).toContain('fetch_url returns the same text');
	});

	it('says the answer may be in the unread part when nothing was found in a cut page', () => {
		const c = cutPage({ text: 'y '.repeat(10_000), full_length: 20_000, hero_image: null }, 2_000);
		expect(researchNote(c, true)).toMatch(/Read the first .* may be in the part not read/);
	});
});

const links = [
	{ text: 'Docs', url: 'https://a.test/docs' },
	{ text: 'API', url: 'https://a.test/api' }
];
const linked = { text: 'x', full_length: 1, hero_image: null, links };

describe('page links', () => {
	it('fetch_url lists as many as fit in the room left', () => {
		expect(fetchLinks(linked, 1_000)).toBe(
			'\n\nLinks on this page:\n- Docs: https://a.test/docs\n- API: https://a.test/api'
		);
		expect(fetchLinks(linked, 50)).toBe('\n\nLinks on this page:\n- Docs: https://a.test/docs');
		expect(fetchLinks(linked, 10)).toBe('');
		expect(fetchLinks({ ...linked, links: [] }, 1_000)).toBe('');
	});

	it('research_url lists them only for thin findings or a focus that asks for pages', () => {
		const long = '- fact\n'.repeat(100);
		expect(researchLinks(linked, long, 'release date')).toBe('');
		expect(researchLinks(linked, '- one fact', 'release date')).toContain('Links on this page');
		expect(researchLinks(linked, long, 'which pages cover the API')).toContain('- API');
	});
});

describe('selectJsonFields', () => {
	it('keeps the named fields of each item in a top-level array', () => {
		const json = JSON.stringify([
			{ name: 'a', id: 1, owner: { login: 'x', id: 9 } },
			{ name: 'b', id: 2, owner: { login: 'y', id: 8 } }
		]);
		expect(JSON.parse(selectJsonFields(json, 'name, owner.login'))).toEqual([
			{ name: 'a', owner: { login: 'x' } },
			{ name: 'b', owner: { login: 'y' } }
		]);
	});

	it('picks through an array partway down a path, keeping items together', () => {
		const json = JSON.stringify({
			total: 2,
			items: [
				{ t: 'one', u: 'https://1', z: 0 },
				{ t: 'two', u: 'https://2' }
			]
		});
		expect(JSON.parse(selectJsonFields(json, 'total,items.t,items.u'))).toEqual({
			total: 2,
			items: [
				{ t: 'one', u: 'https://1' },
				{ t: 'two', u: 'https://2' }
			]
		});
	});

	it('names the fields there are when none matched', () => {
		expect(selectJsonFields('{"a":1,"b":2}', 'c')).toBe(
			'[None of the fields (c) is in this JSON. Its top-level fields are: a, b.]'
		);
	});

	it('leaves text that is not JSON as it was, and says so', () => {
		const out = selectJsonFields('<html>', 'a');
		expect(out).toMatch(/^\[fields was ignored/);
		expect(out).toContain('<html>');
	});
});
