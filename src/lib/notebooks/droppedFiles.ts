/**
 * Documents dropped on a notebook's chat: their text read for the message,
 * and the file kept in the notebook file store so the agent can add the
 * original as an attachment card (`notebook_add_card` with `file`, which
 * looks the hash up here). Kept files the agent never uses are swept at the
 * next start, like any file no card refers to.
 */
import { invoke } from '@tauri-apps/api/core';
import * as api from '#lib/notebooks/api.ts';
import type { NotebookFile } from '#lib/notebooks/api.ts';

/** The most of a document's text put in one message. */
export const MAX_DOC_CHARS = 60_000;

const kept = new Map<string, NotebookFile>();

/** A file dropped this session, by hash. */
export function droppedFile(hash: string): NotebookFile | undefined {
	return kept.get(hash);
}

export function rememberDroppedFile(file: NotebookFile): void {
	kept.set(file.hash, file);
}

/** Which reader a file needs, by extension; null for one the chat can't read. */
export function readerFor(name: string): 'pdf' | 'docx' | 'xlsx' | 'text' | null {
	const ext = name.toLowerCase().split('.').pop() ?? '';
	if (ext === 'pdf') return 'pdf';
	if (ext === 'docx') return 'docx';
	if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') return 'xlsx';
	if (['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'html', 'xml'].includes(ext))
		return 'text';
	return null;
}

/** A path's folder and file name, for the readers' `workdir` + `rel_path`. */
export function splitPath(path: string): { dir: string; name: string } {
	const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return i < 0
		? { dir: '.', name: path }
		: { dir: path.slice(0, i) || '/', name: path.slice(i + 1) };
}

/** The text of a dropped document, read in its own folder. */
export async function readDocument(path: string): Promise<string> {
	const { dir, name } = splitPath(path);
	const args = { workdir: dir, relPath: name };
	switch (readerFor(name)) {
		case 'pdf':
			return invoke<string>('fs_read_pdf', args);
		case 'docx':
			return invoke<string>('fs_read_docx', args);
		case 'xlsx':
			return invoke<string>('fs_read_xlsx', { ...args, sheet: null });
		case 'text':
			return invoke<string>('fs_read_text', { ...args, offset: null, limit: null });
		default:
			throw new Error(`${name} isn't a document the chat can read.`);
	}
}

/** The block a document becomes in the message. */
export function documentBlock(file: NotebookFile, text: string): string {
	const body =
		text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}\n…(cut off here)` : text;
	return `Attached document: ${file.name} (file: ${file.hash})\n\`\`\`\n${body}\n\`\`\``;
}

/** Keep and read a dropped document; returns its message block. */
export async function attachDocument(path: string): Promise<{ file: NotebookFile; block: string }> {
	const [file, text] = await Promise.all([api.storeFilePath(path), readDocument(path)]);
	rememberDroppedFile(file);
	return { file, block: documentBlock(file, text) };
}
