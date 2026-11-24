/**
 * Exporting notebooks: the whole notebook as Markdown (zipped with its
 * files when it has any), HTML (one file, pictures inside), PDF, Word,
 * OpenDocument or a Jupyter notebook; a table as CSV or Excel. Each starts
 * from `notebookToMarkdown`, asks where to save, and writes there.
 */
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { Marked } from 'marked';
import * as api from '#lib/notebooks/api.ts';
import type { NotebookCard, NotebookDetail, NotebookRow } from '#lib/notebooks/api.ts';
import { columnsOf, rawCell } from '#lib/notebooks/columns.ts';
import { writeCsv } from '#lib/notebooks/csv.ts';
import { outputOf } from '#lib/notebooks/pythonRun.ts';
import {
	checklistMarkdown,
	notebookToMarkdown,
	tableMarkdown,
	type ExportFile
} from '#lib/notebooks/toMarkdown.ts';
import { sanitizeHtml } from '#lib/sanitize.ts';
import type { SlideImage } from '#lib/slides/types.ts';
import { imageDimensions } from '#lib/slides/images.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

export type NotebookFormat = 'markdown' | 'html' | 'pdf' | 'docx' | 'odt' | 'ipynb';
export type TableFormat = 'csv' | 'xlsx';

const EXT: Record<NotebookFormat | TableFormat, { ext: string; name: string }> = {
	markdown: { ext: 'md', name: 'Markdown' },
	html: { ext: 'html', name: 'Web page' },
	pdf: { ext: 'pdf', name: 'PDF' },
	docx: { ext: 'docx', name: 'Word document' },
	odt: { ext: 'odt', name: 'OpenDocument text' },
	ipynb: { ext: 'ipynb', name: 'Jupyter notebook' },
	csv: { ext: 'csv', name: 'CSV' },
	xlsx: { ext: 'xlsx', name: 'Excel workbook' }
};

const EMBEDDABLE = /^image\/(png|jpeg|gif)$/;

/** A file name from a title: no path characters, never empty. */
export function safeFileName(title: string): string {
	return title.replace(/[\\/:*?"<>|]/g, '_').trim() || 'notebook';
}

/** The notebook with every table row read, not only the first 200. */
async function fullNotebook(
	id: string
): Promise<{ detail: NotebookDetail; rowsOf: (c: NotebookCard) => NotebookRow[] }> {
	const detail = await api.getNotebook(id);
	const all = new Map<string, NotebookRow[]>();
	for (const c of detail.cards) {
		if ((c.kind === 'table' || c.kind === 'checklist') && c.row_count > c.rows.length) {
			all.set(c.id, await api.getRows(c.id, 0, c.row_count));
		}
	}
	return { detail, rowsOf: (c) => all.get(c.id) ?? c.rows };
}

async function fileBytes(f: ExportFile): Promise<Uint8Array> {
	if (f.dataUrl) {
		const b64 = f.dataUrl.slice(f.dataUrl.indexOf(',') + 1);
		return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	}
	const r = await fetch(api.fileUrl(f.hash ?? ''));
	if (!r.ok) throw new Error(`${f.name} couldn't be read.`);
	return new Uint8Array(await r.arrayBuffer());
}

/** The pictures a PDF or office file embeds, keyed as the Markdown names them. */
async function imagesFor(
	files: ExportFile[],
	ref: (f: ExportFile) => string
): Promise<Map<string, SlideImage>> {
	const map = new Map<string, SlideImage>();
	for (const f of files) {
		if (!EMBEDDABLE.test(f.mime)) continue;
		try {
			const bytes = await fileBytes(f);
			const mime = f.mime as SlideImage['mime'];
			const size = imageDimensions(bytes, mime);
			if (size) map.set(ref(f), { mime, bytes, ...size });
		} catch (e) {
			console.warn('notebook export: a picture was left out', e);
		}
	}
	return map;
}

/** One self-contained HTML page. */
export function htmlPage(title: string, markdown: string): string {
	const body = sanitizeHtml(new Marked({ gfm: true }).parse(markdown) as string);
	const esc = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1f1c17}
table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #ccc;padding:4px 10px;text-align:left}
th{background:#f4f1ea}pre{background:#f6f6f6;padding:.75rem;overflow:auto}img{max-width:100%}
</style></head><body>
${body}
</body></html>
`;
}

const lines = (s: string) => s.split(/(?<=\n)/);
const mdCell = (source: string) => ({ cell_type: 'markdown', metadata: {}, source: lines(source) });

/** A Python card as a code cell, its saved output (text and PNG plots) with it. */
function codeCell(c: NotebookCard): unknown {
	const out = outputOf(c);
	const outputs: unknown[] = [];
	if (out?.stdout) outputs.push({ output_type: 'stream', name: 'stdout', text: lines(out.stdout) });
	if (out?.error) outputs.push({ output_type: 'stream', name: 'stderr', text: lines(out.error) });
	for (const a of out?.artifacts ?? []) {
		if (a.kind === 'image' && a.mime === 'image/png') {
			outputs.push({
				output_type: 'display_data',
				metadata: {},
				data: { 'image/png': a.dataUrl.slice(a.dataUrl.indexOf(',') + 1) }
			});
		}
	}
	return { cell_type: 'code', execution_count: null, metadata: {}, outputs, source: lines(c.body) };
}

/** Any other card as a Markdown cell. */
function markdownCell(c: NotebookCard, rowsOf: (c: NotebookCard) => NotebookRow[]): unknown {
	const head = c.title ? `## ${c.title}\n\n` : '';
	if (c.kind === 'text') return mdCell(head + c.body);
	if (c.kind === 'table')
		return mdCell(head + tableMarkdown(columnsOf(api.parseMeta(c.meta)), rowsOf(c)));
	if (c.kind === 'checklist') return mdCell(head + checklistMarkdown(rowsOf(c)));
	const name = api.parseMeta<{ name?: string }>(c.meta).name ?? 'file';
	return mdCell(`${head}(${c.kind === 'image' ? 'Picture' : 'File'}: ${name})`);
}

/** A Jupyter notebook (nbformat 4): Python cards are code cells, the rest Markdown. */
export function toIpynb(
	detail: NotebookDetail,
	rowsOf: (c: NotebookCard) => NotebookRow[]
): string {
	const cells: unknown[] = [mdCell(`# ${detail.notebook.title}`)];
	for (const c of detail.cards) {
		if (c.kind === 'python') {
			if (c.title) cells.push(mdCell(`## ${c.title}`));
			cells.push(codeCell(c));
		} else {
			cells.push(markdownCell(c, rowsOf));
		}
	}
	return JSON.stringify(
		{ nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } }, cells },
		null,
		1
	);
}

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
	await invoke('notebook_export_bytes', bytes, {
		headers: { 'x-path': encodeURIComponent(path) }
	});
}

async function ask(title: string, format: NotebookFormat | TableFormat, zip = false) {
	const { ext, name } = zip ? { ext: 'zip', name: 'Markdown with files' } : EXT[format];
	return save({
		defaultPath: `${safeFileName(title)}.${ext}`,
		filters: [{ name, extensions: [ext] }]
	});
}

type Full = { detail: NotebookDetail; rowsOf: (c: NotebookCard) => NotebookRow[] };
/** What to save: its bytes and whether it's a zip (Markdown with files). */
type Built = { bytes: Uint8Array; zip?: boolean };

const enc = new TextEncoder();

async function buildMarkdown({ detail, rowsOf }: Full): Promise<Built> {
	const { markdown, files } = notebookToMarkdown(detail, { rowsOf });
	if (files.length === 0) return { bytes: enc.encode(markdown) };
	const { default: JSZip } = await import('jszip');
	const z = new JSZip();
	z.file(`${safeFileName(detail.notebook.title)}.md`, markdown);
	for (const f of files) z.file(`files/${f.name}`, await fileBytes(f));
	return { bytes: await z.generateAsync({ type: 'uint8array' }), zip: true };
}

async function buildHtml({ detail, rowsOf }: Full): Promise<Built> {
	// Pictures go inside the page as data URLs; other files are named.
	const dataUrls = new Map<string, string>();
	for (const f of notebookToMarkdown(detail, { rowsOf }).files) {
		if (/^image\//.test(f.mime)) {
			dataUrls.set(
				f.name,
				f.dataUrl ?? `data:${f.mime};base64,${bytesToBase64(await fileBytes(f))}`
			);
		}
	}
	const { markdown } = notebookToMarkdown(detail, {
		rowsOf,
		fileRef: (f) => dataUrls.get(f.name) ?? '#',
		embeddable: (f) => dataUrls.has(f.name)
	});
	return { bytes: enc.encode(htmlPage(detail.notebook.title, markdown)) };
}

async function buildDocument(
	{ detail, rowsOf }: Full,
	format: 'pdf' | 'docx' | 'odt'
): Promise<Built> {
	const ref = (f: ExportFile) => `files/${encodeURI(f.name)}`;
	const { markdown, files } = notebookToMarkdown(detail, {
		rowsOf,
		embeddable: (f) => EMBEDDABLE.test(f.mime)
	});
	const images = await imagesFor(files, ref);
	const { buildPdf, DEFAULT_OPTIONS } = await import('#lib/documents/pdf.ts');
	if (format === 'pdf') {
		const { gifToPng } = await import('#lib/documents/images.ts');
		return { bytes: (await buildPdf(markdown, images, gifToPng, DEFAULT_OPTIONS)).bytes };
	}
	const { documentModel } = await import('#lib/documents/model.ts');
	const tree = documentModel(markdown);
	const build =
		format === 'docx'
			? (await import('#lib/documents/docx.ts')).buildDocx
			: (await import('#lib/documents/odt.ts')).buildOdt;
	return { bytes: await build(tree, images, DEFAULT_OPTIONS) };
}

/** The bytes of a notebook in `format` (exported for tests). */
export function build(full: Full, format: NotebookFormat): Promise<Built> {
	if (format === 'ipynb')
		return Promise.resolve({ bytes: enc.encode(toIpynb(full.detail, full.rowsOf)) });
	if (format === 'markdown') return buildMarkdown(full);
	if (format === 'html') return buildHtml(full);
	return buildDocument(full, format);
}

/** Export a whole notebook. Returns false when the user cancelled. */
export async function exportNotebook(id: string, format: NotebookFormat): Promise<boolean> {
	try {
		const full = await fullNotebook(id);
		const title = full.detail.notebook.title;
		const built = await build(full, format);
		const path = await ask(title, format, built.zip);
		if (!path) return false;
		await writeBytes(path, built.bytes);
		showToast(`Exported ${title}.`, { kind: 'success' });
		return true;
	} catch (e) {
		showToast(`Export failed: ${errMessage(e)}`, { kind: 'error' });
		return false;
	}
}

/** A table's rows as text cells, its header first. */
export function tableCells(card: NotebookCard, rows: NotebookRow[]): string[][] {
	const cols = columnsOf(api.parseMeta(card.meta));
	return [
		cols.map((c) => c.name),
		...rows.map((r) => {
			const cells = api.parseMeta<Record<string, unknown>>(r.cells);
			return cols.map((c) => rawCell(cells[c.id]));
		})
	];
}

/** Export one table card. */
export async function exportTable(card: NotebookCard, format: TableFormat): Promise<boolean> {
	try {
		const rows =
			card.row_count > card.rows.length ? await api.getRows(card.id, 0, card.row_count) : card.rows;
		const cells = tableCells(card, rows);
		const title = card.title || 'table';
		const path = await ask(title, format);
		if (!path) return false;
		if (format === 'csv') {
			await writeBytes(path, new TextEncoder().encode(writeCsv(cells) + '\n'));
		} else {
			const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
			await invoke('fs_write_xlsx', {
				workdir: path.slice(0, i) || '/',
				relPath: path.slice(i + 1),
				sheets: [
					{ name: title.slice(0, 31).replace(/[[\]:*?/\\]/g, '_') || 'Sheet1', rows: cells }
				],
				overwrite: true
			});
		}
		showToast(`Exported ${title}.`, { kind: 'success' });
		return true;
	} catch (e) {
		showToast(`Export failed: ${errMessage(e)}`, { kind: 'error' });
		return false;
	}
}
