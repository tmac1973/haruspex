import { describe, it, expect } from 'vitest';
import { executeTool } from '$lib/agent/search';

describe('executeTool', () => {
	it('routes web_search to search handler', async () => {
		const result = await executeTool('web_search', { query: 'test query' });
		const parsed = JSON.parse(result);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBeGreaterThan(0);
		expect(parsed[0]).toHaveProperty('title');
		expect(parsed[0]).toHaveProperty('url');
		expect(parsed[0]).toHaveProperty('snippet');
	});

	it('routes fetch_url to fetch handler', async () => {
		const result = await executeTool('fetch_url', { url: 'https://example.com' });
		expect(result).toContain('example.com');
	});

	it('returns error for unknown tool', async () => {
		const result = await executeTool('unknown_tool', {});
		const parsed = JSON.parse(result);
		expect(parsed.error).toContain('Unknown tool');
	});
});
