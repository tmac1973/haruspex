import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn()
}));

import { invoke } from '@tauri-apps/api/core';

describe('executeTool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('routes web_search to proxy_search invoke', async () => {
		const mockResults = [{ title: 'Result 1', url: 'https://example.com', snippet: 'A result' }];
		vi.mocked(invoke).mockResolvedValue(mockResults);

		const { executeTool } = await import('$lib/agent/search');
		const result = await executeTool('web_search', { query: 'test query' }, null);

		expect(invoke).toHaveBeenCalledWith(
			'proxy_search',
			expect.objectContaining({ query: 'test query' })
		);
		expect(JSON.parse(result)).toEqual(mockResults);
	});

	it('routes fetch_url to proxy_fetch invoke', async () => {
		vi.mocked(invoke).mockResolvedValue('page content');

		const { executeTool } = await import('$lib/agent/search');
		const result = await executeTool('fetch_url', { url: 'https://example.com' }, null);

		expect(invoke).toHaveBeenCalledWith('proxy_fetch', { url: 'https://example.com' });
		expect(result).toBe('page content');
	});

	it('returns error for unknown tool', async () => {
		const { executeTool } = await import('$lib/agent/search');
		const result = await executeTool('unknown_tool', {}, null);
		const parsed = JSON.parse(result);
		expect(parsed.error).toContain('Unknown tool');
	});
});
