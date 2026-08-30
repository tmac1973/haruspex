import { describe, it, expect } from 'vitest';
import { eligibleImages, resolvableFromReply } from './eligible';
import type { SearchStep } from '$lib/agent/loop';

function step(partial: Partial<SearchStep> & { toolName: string }): SearchStep {
	return {
		id: Math.random().toString(36),
		query: '',
		status: 'done',
		...partial
	} as SearchStep;
}

function imageSearchStep(...results: Array<Record<string, unknown>>): SearchStep {
	return step({ toolName: 'image_search', result: JSON.stringify({ results }) });
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
