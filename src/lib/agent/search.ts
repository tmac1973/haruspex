import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '$lib/stores/settings';

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export async function executeWebSearch(query: string): Promise<string> {
	try {
		const settings = getSettings();
		const results = await invoke<SearchResult[]>('proxy_search', {
			query,
			provider: settings.searchProvider,
			apiKey: settings.braveApiKey || null,
			instanceUrl: settings.searxngUrl || null
		});
		return JSON.stringify(results);
	} catch (e) {
		return JSON.stringify({ error: `Search failed: ${e}` });
	}
}

export async function executeFetchUrl(url: string): Promise<string> {
	try {
		return await invoke<string>('proxy_fetch', { url });
	} catch (e) {
		return `Failed to fetch URL: ${e}`;
	}
}

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal
): Promise<string> {
	void signal;
	switch (name) {
		case 'web_search':
			return executeWebSearch(args.query as string);
		case 'fetch_url':
			return executeFetchUrl(args.url as string);
		default:
			return JSON.stringify({ error: `Unknown tool: ${name}` });
	}
}
