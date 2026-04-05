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

async function executeFsReadPdf(workdir: string, relPath: string): Promise<string> {
	try {
		return await invoke<string>('fs_read_pdf', { workdir, relPath });
	} catch (e) {
		return JSON.stringify({ error: `fs_read_pdf failed: ${e}` });
	}
}

async function executeFsReadDocx(workdir: string, relPath: string): Promise<string> {
	try {
		return await invoke<string>('fs_read_docx', { workdir, relPath });
	} catch (e) {
		return JSON.stringify({ error: `fs_read_docx failed: ${e}` });
	}
}

async function executeFsReadXlsx(
	workdir: string,
	relPath: string,
	sheet?: string
): Promise<string> {
	try {
		return await invoke<string>('fs_read_xlsx', { workdir, relPath, sheet });
	} catch (e) {
		return JSON.stringify({ error: `fs_read_xlsx failed: ${e}` });
	}
}

async function executeFsWriteDocx(
	workdir: string,
	relPath: string,
	content: string
): Promise<string> {
	try {
		await invoke('fs_write_docx', { workdir, relPath, content });
		return `Wrote docx: ${relPath}`;
	} catch (e) {
		return JSON.stringify({ error: `fs_write_docx failed: ${e}` });
	}
}

interface XlsxSheet {
	name: string;
	rows: string[][];
}

async function executeFsWriteXlsx(
	workdir: string,
	relPath: string,
	sheets: XlsxSheet[]
): Promise<string> {
	try {
		await invoke('fs_write_xlsx', { workdir, relPath, sheets });
		return `Wrote xlsx: ${relPath} (${sheets.length} sheet${sheets.length === 1 ? '' : 's'})`;
	} catch (e) {
		return JSON.stringify({ error: `fs_write_xlsx failed: ${e}` });
	}
}

async function executeFsReadImage(
	workdir: string,
	relPath: string,
	pendingImages: Array<{ path: string; dataUrl: string }>
): Promise<string> {
	try {
		const dataUrl = await invoke<string>('fs_read_image', { workdir, relPath });
		pendingImages.push({ path: relPath, dataUrl });
		return `Image loaded: ${relPath}. You can now see it — describe or analyze it in your next response.`;
	} catch (e) {
		return JSON.stringify({ error: `fs_read_image failed: ${e}` });
	}
}

async function executeFsReadPdfPages(
	workdir: string,
	relPath: string,
	pendingImages: Array<{ path: string; dataUrl: string }>
): Promise<string> {
	try {
		// Dynamic import so PDF.js (and its worker) is only loaded when actually used
		const { renderPdfPages } = await import('$lib/agent/pdf-render');
		const pages = await renderPdfPages(workdir, relPath);
		for (let i = 0; i < pages.length; i++) {
			pendingImages.push({ path: `${relPath}#page${i + 1}`, dataUrl: pages[i] });
		}
		return `Rendered ${pages.length} page${pages.length === 1 ? '' : 's'} of ${relPath} as images. You can now see the pages in your next response — read form fields, labels, values, and layout directly.`;
	} catch (e) {
		return JSON.stringify({ error: `fs_read_pdf_pages failed: ${e}` });
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

export interface PendingImage {
	path: string;
	dataUrl: string;
}

// Max images per turn. Each ~1024px image is ~500-800 image tokens for
// Qwen3.5-9B vision; batching more than this at once risks blowing out the
// KV cache and crashing llama-server with "find_slot: non-consecutive token
// position" errors. The model should respond about loaded images before
// loading more.
const MAX_PENDING_IMAGES = 6;

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	workingDir: string | null,
	signal?: AbortSignal,
	pendingImages?: PendingImage[]
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
		case 'fs_read_pdf':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			return executeFsReadPdf(workingDir, args.path as string);
		case 'fs_read_docx':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			return executeFsReadDocx(workingDir, args.path as string);
		case 'fs_read_xlsx':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			return executeFsReadXlsx(workingDir, args.path as string, args.sheet as string | undefined);
		case 'fs_read_image':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			if (!pendingImages) return JSON.stringify({ error: 'Images not supported in this context' });
			if (pendingImages.length >= MAX_PENDING_IMAGES) {
				return JSON.stringify({
					error: `Too many images pending (${pendingImages.length}). Respond about the images you've already loaded before loading more — loading too many images in one turn exhausts the model context and crashes inference.`
				});
			}
			return executeFsReadImage(workingDir, args.path as string, pendingImages);
		case 'fs_read_pdf_pages':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			if (!pendingImages) return JSON.stringify({ error: 'Images not supported in this context' });
			if (pendingImages.length > 0) {
				return JSON.stringify({
					error: `You already have ${pendingImages.length} image(s) pending. Respond about them first, then call fs_read_pdf_pages for the next PDF. Loading multiple PDFs as images in one turn crashes the inference server.`
				});
			}
			return executeFsReadPdfPages(workingDir, args.path as string, pendingImages);
		case 'fs_write_text':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			return executeFsWriteText(
				workingDir,
				args.path as string,
				args.content as string,
				args.overwrite as boolean | undefined
			);
		case 'fs_write_docx':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			return executeFsWriteDocx(workingDir, args.path as string, args.content as string);
		case 'fs_write_xlsx':
			if (!workingDir) return JSON.stringify({ error: 'No working directory set' });
			return executeFsWriteXlsx(workingDir, args.path as string, args.sheets as XlsxSheet[]);
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
