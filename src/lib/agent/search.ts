import { invoke } from '@tauri-apps/api/core';

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

// These functions are the real tool executors.
// Phase 5 uses mocks; Phase 6 replaces with real Tauri invoke calls.

let useMocks = true;

export function setUseMocks(value: boolean): void {
	useMocks = value;
}

export async function executeWebSearch(query: string, signal?: AbortSignal): Promise<string> {
	void signal;
	if (useMocks) {
		return JSON.stringify(mockSearchResults(query));
	}
	const results = await invoke<SearchResult[]>('proxy_search', { query });
	return JSON.stringify(results);
}

export async function executeFetchUrl(url: string, signal?: AbortSignal): Promise<string> {
	void signal;
	if (useMocks) {
		return mockFetchResult(url);
	}
	return await invoke<string>('proxy_fetch', { url });
}

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal
): Promise<string> {
	switch (name) {
		case 'web_search':
			return executeWebSearch(args.query as string, signal);
		case 'fetch_url':
			return executeFetchUrl(args.url as string, signal);
		default:
			return JSON.stringify({ error: `Unknown tool: ${name}` });
	}
}

// Mock implementations for Phase 5 testing

function mockSearchResults(query: string): SearchResult[] {
	return [
		{
			title: `${query} - Latest Information`,
			url: `https://example.com/article-1`,
			snippet: `Here is some relevant information about "${query}". This is a mock search result for development testing.`
		},
		{
			title: `Understanding ${query}`,
			url: `https://example.com/article-2`,
			snippet: `A comprehensive guide to ${query}. Contains detailed analysis and up-to-date data.`
		},
		{
			title: `${query} News and Updates`,
			url: `https://example.com/article-3`,
			snippet: `The latest news about ${query}. Updated regularly with current information.`
		}
	];
}

function mockFetchResult(url: string): string {
	return `[Content fetched from ${url}]\n\nThis is mock content for development testing. In production, this would contain the actual text extracted from the web page at ${url}.\n\nThe page discusses the topic in detail with multiple sections covering background, current status, and future outlook.`;
}
