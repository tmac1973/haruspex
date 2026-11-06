import { afterEach, describe, expect, it } from 'vitest';
import { helperPrompt, helpers } from '#lib/helpers/registry.ts';
import { setCodeHelperConfig } from '#lib/stores/settings.ts';
import { searchReranked } from './config';
import './helper';

const search = () => helpers().find((h) => h.id === 'search')!;

describe('the Search helper’s TOOLS line', () => {
	afterEach(() => setCodeHelperConfig('search', undefined));

	it('says to search first only with a reranker set', () => {
		expect(searchReranked()).toBe(false);
		expect(helperPrompt(search())).toMatch(/^- search_code — /);
		expect(helperPrompt(search())).not.toContain('FIRST');
		setCodeHelperConfig('search', { rerank: { url: 'http://box:3000', model: 'm' } });
		expect(searchReranked()).toBe(true);
		expect(helperPrompt(search())).toContain('Use it FIRST');
	});
});
