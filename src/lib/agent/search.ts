import { invoke } from '@tauri-apps/api/core';

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export async function executeWebSearch(query: string, signal?: AbortSignal): Promise<string> {
	void signal;
	const results = await invoke<SearchResult[]>('proxy_search', { query });
	return JSON.stringify(results);
}

export async function executeFetchUrl(url: string, signal?: AbortSignal): Promise<string> {
	void signal;
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
