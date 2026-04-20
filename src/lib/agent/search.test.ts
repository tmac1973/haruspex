import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn()
}));

import { invoke } from '@tauri-apps/api/core';

const defaultCtx = {
	workingDir: null,
	pendingImages: [],
	deepResearch: false,
	filesWrittenThisTurn: new Set<string>()
};

describe('executeTool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('routes web_search to proxy_search invoke', async () => {
		const mockResults = [{ title: 'Result 1', url: 'https://example.com', snippet: 'A result' }];
		vi.mocked(invoke).mockResolvedValue(mockResults);

		const { executeTool } = await import('$lib/agent/tools');
		const output = await executeTool('web_search', { query: 'test query' }, defaultCtx);

		expect(invoke).toHaveBeenCalledWith(
			'proxy_search',
			expect.objectContaining({ query: 'test query' })
		);
		expect(JSON.parse(output.result)).toEqual(mockResults);
		expect(output.thumbDataUrl).toBeUndefined();
	});

	it('routes fetch_url to proxy_fetch invoke', async () => {
		vi.mocked(invoke).mockResolvedValue('page content');

		const { executeTool } = await import('$lib/agent/tools');
		const output = await executeTool('fetch_url', { url: 'https://example.com' }, defaultCtx);

		expect(invoke).toHaveBeenCalledWith(
			'proxy_fetch',
			expect.objectContaining({ url: 'https://example.com', caller: 'fetch_url' })
		);
		expect(output.result).toBe('page content');
	});

	it('returns error for unknown tool', async () => {
		const { executeTool } = await import('$lib/agent/tools');
		const output = await executeTool('unknown_tool', {}, defaultCtx);
		const parsed = JSON.parse(output.result);
		expect(parsed.error).toContain('Unknown tool');
	});
});
