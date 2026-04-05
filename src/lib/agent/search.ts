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
			instanceUrl: settings.searxngUrl || null,
			recency: settings.searchRecency || null
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

// --- Filesystem tool dispatch ---

interface DirListing {
	path: string;
	entries: Array<{ name: string; is_dir: boolean; size: number }>;
	truncated: boolean;
}

function formatDirListing(listing: DirListing): string {
	const lines: string[] = [`Directory: ${listing.path}`];
	if (listing.entries.length === 0) {
		lines.push('(empty)');
	}
	for (const entry of listing.entries) {
		const marker = entry.is_dir ? '[DIR] ' : '      ';
		const size = entry.is_dir ? '' : ` (${entry.size} bytes)`;
		lines.push(`${marker}${entry.name}${size}`);
	}
	if (listing.truncated) {
		lines.push('... (listing truncated; more than 500 entries)');
	}
	return lines.join('\n');
}

async function executeFsListDir(workdir: string, relPath: string): Promise<string> {
	try {
		const listing = await invoke<DirListing>('fs_list_dir', { workdir, relPath });
		return formatDirListing(listing);
	} catch (e) {
		return JSON.stringify({ error: `fs_list_dir failed: ${e}` });
	}
}

async function executeFsReadText(workdir: string, relPath: string): Promise<string> {
	try {
		return await invoke<string>('fs_read_text', { workdir, relPath });
	} catch (e) {
		return JSON.stringify({ error: `fs_read_text failed: ${e}` });
	}
}

async function executeFsWriteText(
	workdir: string,
	relPath: string,
	content: string,
	overwrite?: boolean
): Promise<string> {
	try {
		await invoke('fs_write_text', { workdir, relPath, content, overwrite });
		return `Wrote ${content.length} bytes to ${relPath}`;
	} catch (e) {
		return JSON.stringify({ error: `fs_write_text failed: ${e}` });
	}
}

async function executeFsEditText(
	workdir: string,
	relPath: string,
	oldStr: string,
	newStr: string
): Promise<string> {
	try {
		await invoke('fs_edit_text', { workdir, relPath, oldStr, newStr });
		return `Edited ${relPath}`;
	} catch (e) {
		return JSON.stringify({ error: `fs_edit_text failed: ${e}` });
	}
}

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	workingDir: string | null,
	signal?: AbortSignal
): Promise<string> {
	void signal;
	switch (name) {
		case 'web_search':
			return executeWebSearch(args.query as string);
		case 'fetch_url':
			return executeFetchUrl(args.url as string);
		case 'fs_list_dir':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			return executeFsListDir(workingDir, (args.path as string) ?? '.');
		case 'fs_read_text':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			return executeFsReadText(workingDir, args.path as string);
		case 'fs_write_text':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			return executeFsWriteText(
				workingDir,
				args.path as string,
				args.content as string,
				args.overwrite as boolean | undefined
			);
		case 'fs_edit_text':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			return executeFsEditText(
				workingDir,
				args.path as string,
				args.old_str as string,
				args.new_str as string
			);
		default:
			return JSON.stringify({ error: `Unknown tool: ${name}` });
	}
}
