/**
 * A notebook as Markdown, the form every export starts from. Text cards go
 * through as written; tables become GFM tables; checklists task lists;
 * Python cards their code and output; files and pictures links or images
 * under `files/`. What a file's link points at is the caller's choice
 * (`fileRef`): a path in a zip, or a data URL in one HTML file.
 */
import * as api from '#lib/notebooks/api.ts';
import type { NotebookCard, NotebookDetail, NotebookRow } from '#lib/notebooks/api.ts';
import { columnsOf, formatCell, type Column } from '#lib/notebooks/columns.ts';
import { outputOf } from '#lib/notebooks/pythonOutput.ts';

/** A file the Markdown refers to: a kept file, or a Python card's plot. */
export interface ExportFile {
	/** Its name under `files/`, unique in the notebook. */
	name: string;
	/** A kept file's hash, or the plot's data URL. */
	hash?: string;
	dataUrl?: string;
	mime: string;
}

export interface MarkdownOptions {
	/** Where a file's link points; `files/<name>` when absent. */
	fileRef?: (file: ExportFile) => string;
	/** False: an image card's picture can't be shown here, so it becomes a link. */
	embeddable?: (file: ExportFile) => boolean;
	/** All of a table's rows (the card holds the first 200). */
	rowsOf?: (card: NotebookCard) => NotebookRow[];
	/**
	 * Name files and pictures in brackets ("[Picture: map.png]") rather than
	 * link them: for text that goes nowhere a link could follow (an email
	 * body). A function decides per file: an email shows its pictures and
	 * only names the files it attaches.
	 */
	placeholders?: boolean | ((file: ExportFile) => boolean);
}

/** A cell for a GFM table: one line, pipes escaped, links as [host](url). */
export function gfmCell(col: Column, value: unknown): string {
	if (col.type === 'url' && typeof value === 'string' && /^https?:\/\//i.test(value)) {
		const label = value.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
		return `[${label.replace(/[[\]|]/g, '')}](${value.replace(/[()\s]/g, encodeURIComponent)})`;
	}
	return formatCell(col, value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function tableMarkdown(columns: Column[], rows: NotebookRow[]): string {
	if (columns.length === 0) return '';
	const head = `| ${columns.map((c) => c.name.replace(/\|/g, '\\|')).join(' | ')} |`;
	const rule = `| ${columns.map((c) => (c.type === 'number' || c.type === 'currency' ? '---:' : '---')).join(' | ')} |`;
	const body = rows.map((r) => {
		const cells = api.parseMeta<Record<string, unknown>>(r.cells);
		return `| ${columns.map((c) => gfmCell(c, cells[c.id])).join(' | ')} |`;
	});
	return [head, rule, ...body].join('\n');
}

export function checklistMarkdown(rows: NotebookRow[]): string {
	return rows
		.map((r) => {
			const c = api.parseMeta<{ text?: string; done?: boolean }>(r.cells);
			return `- [${c.done ? 'x' : ' '}] ${(c.text ?? '').replace(/\r?\n/g, ' ')}`;
		})
		.join('\n');
}

/** Names unique within one export: `a.png`, `a (2).png`. */
export function uniqueNamer(): (name: string) => string {
	const used = new Set<string>();
	return (name: string) => {
		const clean = name.replace(/[\\/:*?"<>|]/g, '_') || 'file';
		const m = /^(.*?)(\.[^.]*)?$/.exec(clean)!;
		let candidate = clean;
		for (let n = 2; used.has(candidate.toLowerCase()); n++)
			candidate = `${m[1]} (${n})${m[2] ?? ''}`;
		used.add(candidate.toLowerCase());
		return candidate;
	};
}

interface CardContext {
	ref: (f: ExportFile) => string;
	rowsOf: (c: NotebookCard) => NotebookRow[];
	name: (n: string) => string;
	files: ExportFile[];
	embeddable?: (f: ExportFile) => boolean;
	placeholders?: MarkdownOptions['placeholders'];
}

/** Whether `f` is named in brackets rather than linked. */
function named(ctx: CardContext, f: ExportFile): boolean {
	return typeof ctx.placeholders === 'function' ? ctx.placeholders(f) : !!ctx.placeholders;
}

/** "[Picture: a.png]" in place of a picture or a file link. */
function placeholder(f: ExportFile, picture: boolean): string {
	return `[${picture ? 'Picture' : 'File'}: ${f.name}]`;
}

function pythonParts(card: NotebookCard, ctx: CardContext): string[] {
	const parts = ['```python\n' + card.body.trimEnd() + '\n```'];
	const output = outputOf(card);
	if (output?.stdout.trim()) parts.push('```\n' + output.stdout.trimEnd() + '\n```');
	if (output?.error) parts.push('```\n' + output.error.trimEnd() + '\n```');
	output?.artifacts.forEach((a, i) => {
		if (a.kind !== 'image') return;
		const f: ExportFile = {
			name: ctx.name(`${card.title || 'plot'}-${i + 1}.png`),
			dataUrl: a.dataUrl,
			mime: a.mime
		};
		ctx.files.push(f);
		parts.push(named(ctx, f) ? placeholder(f, true) : `![${a.alt ?? 'plot'}](${ctx.ref(f)})`);
	});
	return parts;
}

function fileParts(card: NotebookCard, ctx: CardContext): string[] {
	const m = api.parseMeta<{ hash?: string; name?: string; mime?: string }>(card.meta);
	if (!m.hash) return [];
	const f: ExportFile = {
		name: ctx.name(m.name ?? 'file'),
		hash: m.hash,
		mime: m.mime ?? 'application/octet-stream'
	};
	ctx.files.push(f);
	const asImage = card.kind === 'image' && (ctx.embeddable?.(f) ?? true);
	if (named(ctx, f)) return [placeholder(f, card.kind === 'image')];
	return [asImage ? `![${card.title || f.name}](${ctx.ref(f)})` : `[${f.name}](${ctx.ref(f)})`];
}

/** One card's Markdown, under its title. */
function cardMarkdown(card: NotebookCard, ctx: CardContext): string {
	const parts: string[] = card.title ? [`## ${card.title}`] : [];
	if (card.kind === 'text') parts.push(card.body.trim());
	else if (card.kind === 'table')
		parts.push(tableMarkdown(columnsOf(api.parseMeta(card.meta)), ctx.rowsOf(card)));
	else if (card.kind === 'checklist') parts.push(checklistMarkdown(ctx.rowsOf(card)));
	else if (card.kind === 'python') parts.push(...pythonParts(card, ctx));
	else if (card.kind === 'attachment' || card.kind === 'image') parts.push(...fileParts(card, ctx));
	return parts.filter((p) => p.trim()).join('\n\n');
}

/** The notebook as Markdown, and the files it refers to. */
export function notebookToMarkdown(
	detail: NotebookDetail,
	opts: MarkdownOptions = {}
): { markdown: string; files: ExportFile[] } {
	const ctx: CardContext = {
		ref: opts.fileRef ?? ((f: ExportFile) => `files/${encodeURI(f.name)}`),
		rowsOf: opts.rowsOf ?? ((c: NotebookCard) => c.rows),
		name: uniqueNamer(),
		files: [],
		embeddable: opts.embeddable,
		placeholders: opts.placeholders
	};
	const out: string[] = [`# ${detail.notebook.title}`];
	if (detail.notebook.tags.length) out.push(`Tags: ${detail.notebook.tags.join(', ')}`);
	for (const card of detail.cards) {
		const block = cardMarkdown(card, ctx);
		if (block) out.push(block);
	}
	return { markdown: out.join('\n\n') + '\n', files: ctx.files };
}
