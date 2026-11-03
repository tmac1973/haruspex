import { describe, expect, it } from 'vitest';
import { parseSearchConfig } from './config';

describe('parseSearchConfig', () => {
	it('has no reranker when nothing is stored', () => {
		expect(parseSearchConfig(undefined)).toEqual({ rerank: null });
		expect(parseSearchConfig(null)).toEqual({ rerank: null });
		expect(parseSearchConfig('garbage')).toEqual({ rerank: null });
		expect(parseSearchConfig({})).toEqual({ rerank: null });
	});

	it('needs both a URL and a model', () => {
		expect(parseSearchConfig({ rerank: { url: 'http://box:3000' } })).toEqual({ rerank: null });
		expect(parseSearchConfig({ rerank: { url: '', model: 'm' } })).toEqual({ rerank: null });
		expect(parseSearchConfig({ rerank: { url: 'http://box:3000', model: 3 } })).toEqual({
			rerank: null
		});
	});

	it('keeps a valid reranker, with a key id only when it is a string', () => {
		expect(
			parseSearchConfig({ rerank: { url: 'http://box:3000', model: 'm', keyId: 'key_1' } })
		).toEqual({ rerank: { url: 'http://box:3000', model: 'm', keyId: 'key_1' } });
		expect(parseSearchConfig({ rerank: { url: 'http://box:3000', model: 'm', keyId: 7 } })).toEqual(
			{ rerank: { url: 'http://box:3000', model: 'm', keyId: null } }
		);
	});
});
