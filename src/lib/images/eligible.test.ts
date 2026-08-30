import { describe, it, expect } from 'vitest';
import { eligibleImages, resolvableFromReply, stripCandidates } from './eligible';
import type { SearchStep } from '$lib/agent/loop';

function step(partial: Partial<SearchStep> & { toolName: string }): SearchStep {
	return {
		id: Math.random().toString(36),
		query: '',
		status: 'done',
		...partial
	} as SearchStep;
}

/**
 * Mirrors the real tool result: a JSON object followed by the `[Haruspex hint]`
 * block the tool appends. A whole-string JSON.parse would throw on this.
 */
function imageSearchStep(...results: Array<Record<string, unknown>>): SearchStep {
	return step({
		toolName: 'image_search',
		result:
			JSON.stringify({ results }) +
			'\n\n[Haruspex hint] To show an image, copy one of these lines into the answer you are ' +
			'about to write:\n![a thing](https://example.test/thumb.jpg)\nUse at most 3.'
	});
}

const COMMONS = {
	url: 'https://upload.wikimedia.org/panda.jpg',
	source: 'commons',
	license: 'CC BY-SA 4.0',
	attribution: 'A Photographer',
	description_url: 'https://commons.wikimedia.org/wiki/File:Panda.jpg'
};

describe('eligibleImages', () => {
	it('accepts every image_search result with its provenance', () => {
		const eligible = eligibleImages([imageSearchStep(COMMONS)]);
		const req = eligible.get(COMMONS.url);
		expect(req).toBeDefined();
		expect(req?.source).toBe('commons');
		expect(req?.license).toBe('CC BY-SA 4.0');
		expect(req?.attribution).toBe('A Photographer');
	});

	it('accepts a fetched page hero image, tagged page_og with no licence', () => {
		const eligible = eligibleImages([
			step({ toolName: 'fetch_url', heroImage: 'https://news.example/hero.jpg' })
		]);
		const req = eligible.get('https://news.example/hero.jpg');
		expect(req?.source).toBe('page_og');
		// Rust turns page_og into license unknown / embeddable false whatever
		// the page claimed, so nothing is asserted about it here.
		expect(req?.license).toBeNull();
	});

	it('accepts research_url hero images too', () => {
		const eligible = eligibleImages([
			step({ toolName: 'research_url', heroImage: 'https://news.example/r.jpg' })
		]);
		expect(eligible.has('https://news.example/r.jpg')).toBe(true);
	});

	it('adds nothing from any other tool', () => {
		const eligible = eligibleImages([
			step({ toolName: 'web_search', result: '[{"url":"https://evil.test/x.png"}]' }),
			step({ toolName: 'run_python', result: 'https://evil.test/y.png' }),
			step({ toolName: 'fetch_url' })
		]);
		expect(eligible.size).toBe(0);
	});

	it('ignores a malformed image_search result rather than widening the set', () => {
		for (const result of ['not json', '{}', '{"results":"nope"}', '{"results":[{}]}', '']) {
			expect(eligibleImages([step({ toolName: 'image_search', result })]).size).toBe(0);
		}
	});

	it('keeps the first provenance when two sources return the same URL', () => {
		const eligible = eligibleImages([
			imageSearchStep(COMMONS, { ...COMMONS, source: 'openverse', attribution: 'Someone Else' })
		]);
		expect(eligible.size).toBe(1);
		expect(eligible.get(COMMONS.url)?.attribution).toBe('A Photographer');
	});
});

describe('resolvableFromReply', () => {
	const eligible = eligibleImages([
		imageSearchStep(COMMONS),
		step({ toolName: 'fetch_url', heroImage: 'https://news.example/hero.jpg' })
	]);

	it('resolves an eligible image the reply asks for', () => {
		const out = resolvableFromReply(`Here it is:\n\n![a panda](${COMMONS.url})`, eligible, 3);
		expect(out).toHaveLength(1);
		expect(out[0].url).toBe(COMMONS.url);
	});

	// The injection guard. A page the model read can put arbitrary markdown in
	// front of it, including a beacon URL; echoing it must never cause a fetch.
	it('refuses a URL no tool result produced', () => {
		const injected = '![](https://attacker.example/beacon.png)';
		expect(resolvableFromReply(injected, eligible, 3)).toHaveLength(0);
	});

	it('refuses a hallucinated but plausible URL', () => {
		const made_up = '![panda](https://upload.wikimedia.org/panda-large.jpg)';
		expect(resolvableFromReply(made_up, eligible, 3)).toHaveLength(0);
	});

	it('mixes eligible and ineligible refs, keeping only the eligible ones', () => {
		const text = `![ok](${COMMONS.url})\n![bad](https://attacker.example/x.png)\n![ok2](https://news.example/hero.jpg)`;
		const out = resolvableFromReply(text, eligible, 3);
		expect(out.map((r) => r.url)).toEqual([COMMONS.url, 'https://news.example/hero.jpg']);
	});

	it('enforces the cap even when the model asks for more', () => {
		const many = eligibleImages([
			imageSearchStep(
				{ ...COMMONS, url: 'https://e.test/1.jpg' },
				{ ...COMMONS, url: 'https://e.test/2.jpg' },
				{ ...COMMONS, url: 'https://e.test/3.jpg' },
				{ ...COMMONS, url: 'https://e.test/4.jpg' },
				{ ...COMMONS, url: 'https://e.test/5.jpg' }
			)
		]);
		const text = [1, 2, 3, 4, 5].map((n) => `![x](https://e.test/${n}.jpg)`).join('\n');
		const out = resolvableFromReply(text, many, 3);
		expect(out).toHaveLength(3);
		// Document order, so the model's own ranking is respected.
		expect(out.map((r) => r.url)).toEqual([
			'https://e.test/1.jpg',
			'https://e.test/2.jpg',
			'https://e.test/3.jpg'
		]);
	});

	it('counts a repeated URL once against the cap', () => {
		const text = `![a](${COMMONS.url})\n![a again](${COMMONS.url})`;
		expect(resolvableFromReply(text, eligible, 3)).toHaveLength(1);
	});

	it('finds nothing in a reply with no images', () => {
		expect(resolvableFromReply('Just prose, and a [link](https://e.test).', eligible, 3)).toEqual(
			[]
		);
	});
});

describe('image_search result shape', () => {
	it('survives the hint text appended after the JSON', () => {
		// Regression: the tool appends a [Haruspex hint] block, and a
		// whole-string JSON.parse threw on it — which emptied the eligibility
		// set, so every image was silently dropped at render with no error
		// logged anywhere.
		const eligible = eligibleImages([imageSearchStep(COMMONS)]);
		expect(eligible.size).toBeGreaterThan(0);
		expect(eligible.has(COMMONS.url)).toBe(true);
	});

	it('accepts the thumbnail as well as the full-size URL', () => {
		// The hint hands the model markdown built from thumb_url, but nothing
		// stops it copying `url` out of the JSON instead. Registering only one
		// would silently drop whichever it picked.
		const withThumb = { ...COMMONS, thumb_url: 'https://upload.wikimedia.org/960px-panda.jpg' };
		const eligible = eligibleImages([imageSearchStep(withThumb)]);
		expect(eligible.has(COMMONS.url)).toBe(true);
		expect(eligible.has('https://upload.wikimedia.org/960px-panda.jpg')).toBe(true);
		// Both carry the same provenance, so the caption is right either way.
		expect(eligible.get('https://upload.wikimedia.org/960px-panda.jpg')?.attribution).toBe(
			'A Photographer'
		);
	});

	it('does not duplicate when thumb_url equals url', () => {
		const same = { ...COMMONS, thumb_url: COMMONS.url };
		expect(eligibleImages([imageSearchStep(same)]).size).toBe(1);
	});

	it('still yields nothing for a result that is not JSON at all', () => {
		expect(
			eligibleImages([step({ toolName: 'image_search', result: 'total nonsense' })]).size
		).toBe(0);
	});
});

describe('stripCandidates', () => {
	const withThumb = (url: string, thumb: string) => ({
		...COMMONS,
		url,
		thumb_url: thumb
	});

	it('prefers the thumbnail over the full-size original', () => {
		// Right-sized for display and a fraction of the bytes — the sampled
		// Commons pair was 1 MB against 170 KB.
		const out = stripCandidates([
			imageSearchStep(withThumb('https://e.test/big.jpg', 'https://e.test/960px.jpg'))
		]);
		expect(out).toHaveLength(1);
		expect(out[0].url).toBe('https://e.test/960px.jpg');
	});

	it('takes one image per search, not the whole result set', () => {
		// "monkeys in the wild" returns three near-identical frames from the
		// same photographer; showing all three looks broken, not illustrated.
		const out = stripCandidates([
			imageSearchStep(
				withThumb('https://e.test/a.jpg', 'https://e.test/a-thumb.jpg'),
				withThumb('https://e.test/b.jpg', 'https://e.test/b-thumb.jpg'),
				withThumb('https://e.test/c.jpg', 'https://e.test/c-thumb.jpg')
			)
		]);
		expect(out).toHaveLength(1);
		expect(out[0].url).toBe('https://e.test/a-thumb.jpg');
	});

	it('takes one from each of several searches', () => {
		const out = stripCandidates([
			imageSearchStep(withThumb('https://e.test/1.jpg', 'https://e.test/1t.jpg')),
			imageSearchStep(withThumb('https://e.test/2.jpg', 'https://e.test/2t.jpg'))
		]);
		expect(out.map((r) => r.url)).toEqual(['https://e.test/1t.jpg', 'https://e.test/2t.jpg']);
	});

	it('caps the number shown', () => {
		const steps = [1, 2, 3, 4, 5].map((n) =>
			imageSearchStep(withThumb(`https://e.test/${n}.jpg`, `https://e.test/${n}t.jpg`))
		);
		expect(stripCandidates(steps)).toHaveLength(3);
		expect(stripCandidates(steps, 2)).toHaveLength(2);
	});

	// og:image is harvested from every page a research turn fetches, with the
	// model never asking for it. Auto-showing those would staple an arbitrary
	// hero image under every research answer.
	it('ignores page hero images entirely', () => {
		const out = stripCandidates([
			step({ toolName: 'fetch_url', heroImage: 'https://news.example/hero.jpg' }),
			step({ toolName: 'research_url', heroImage: 'https://news.example/r.jpg' })
		]);
		expect(out).toHaveLength(0);
	});

	it('yields nothing when no image_search ran', () => {
		expect(stripCandidates([step({ toolName: 'web_search', result: '[]' })])).toHaveLength(0);
		expect(stripCandidates([])).toHaveLength(0);
	});

	it('carries provenance so the caption is still correct', () => {
		const out = stripCandidates([
			imageSearchStep(withThumb('https://e.test/x.jpg', 'https://e.test/xt.jpg'))
		]);
		expect(out[0].attribution).toBe('A Photographer');
		expect(out[0].license).toBe('CC BY-SA 4.0');
		expect(out[0].source).toBe('commons');
	});
});
