/**
 * How the notebook tools show notebooks to a model and read its edits:
 * outlines, tables as CSV with a `row_id` column, and the small text
 * formats (`row_id: Column=value`, checklist `[x]` lines) the tools take.
 */
import * as api from '#lib/notebooks/api.ts';
import type { NotebookCard, RowOp } from '#lib/notebooks/api.ts';
import { columnsOf, parseCell, rawCell, type Column } from '#lib/notebooks/columns.ts';
import { rowsFromCsv, writeCsv } from '#lib/notebooks/csv.ts';

const OUTLINE_TEXT = 300;
const OUTLINE_ROWS = 10;
export const PAGE_ROWS = 100;
const CHECKLIST_COLUMNS: Column[] = [
	{ id: 'text', name: 'text', type: 'text' },
	{ id: 'done', name: 'done', type: 'checkbox' }
];

export function columnsFor(card: NotebookCard): Column[] {
	return card.kind === 'checklist' ? CHECKLIST_COLUMNS : columnsOf(api.parseMeta(card.meta));
}

export function cellsOf(row: api.NotebookRow): Record<string, unknown> {
	return api.parseMeta<Record<string, unknown>>(row.cells);
}

/** Rows as CSV with a `row_id` first column and `Name:type` headers. */
export function rowsToCsv(card: NotebookCard, rows: api.NotebookRow[]): string {
	const cols = columnsFor(card);
	const header = ['row_id', ...cols.map((c) => `${c.name}:${c.type}`)];
	const body = rows.map((r) => {
		const cells = cellsOf(r);
		return [r.id, ...cols.map((c) => rawCell(cells[c.id]))];
	});
	return writeCsv([header, ...body]);
}

function cardHeading(card: NotebookCard): string {
	const title = card.title ? ` "${card.title}"` : '';
	return `[${card.id}] ${card.kind}${title}`;
}

function fileLine(card: NotebookCard): string {
	const m = api.parseMeta<{ name?: string; mime?: string; size?: number }>(card.meta);
	return `${m.name ?? 'file'} (${m.mime ?? 'unknown type'}, ${m.size ?? 0} bytes)`;
}

/** One card, as the outline shows it. */
export function cardOutline(card: NotebookCard): string {
	const head = cardHeading(card);
	switch (card.kind) {
		case 'text': {
			const body =
				card.body.length > OUTLINE_TEXT ? `${card.body.slice(0, OUTLINE_TEXT)}…` : card.body;
			return `${head}\n${body || '(empty)'}`;
		}
		case 'table':
		case 'checklist': {
			const more =
				card.row_count > OUTLINE_ROWS
					? `\n…${card.row_count - OUTLINE_ROWS} more rows; notebook_read with card="${card.id}" for all`
					: '';
			return `${head} — ${card.row_count} rows\n${rowsToCsv(card, card.rows.slice(0, OUTLINE_ROWS))}${more}`;
		}
		case 'python':
			return `${head}\n\`\`\`python\n${card.body.slice(0, OUTLINE_TEXT)}\n\`\`\``;
		default:
			return `${head} — ${fileLine(card)}`;
	}
}

/** One card in full (tables a page at a time). */
export async function cardFull(card: NotebookCard, offset: number, limit: number): Promise<string> {
	if (card.kind === 'table' || card.kind === 'checklist') {
		const rows = await api.getRows(card.id, offset, limit);
		const end = offset + rows.length;
		const more =
			end < card.row_count
				? `\nRows ${offset + 1}–${end} of ${card.row_count}; next: offset=${end}.`
				: `\n${card.row_count} rows.`;
		return `${cardHeading(card)}\n${rowsToCsv(card, rows)}${more}`;
	}
	if (card.kind === 'text') return `${cardHeading(card)}\n${card.body || '(empty)'}`;
	if (card.kind === 'python') {
		const out = api.parseMeta<{ output?: { stdout?: string; error?: string | null } }>(
			card.meta
		).output;
		const result = out
			? `\nLast output:\n${out.error ? `Error: ${out.error}` : (out.stdout ?? '').slice(0, 4000) || '(no text output)'}`
			: '\nNot run yet.';
		return `${cardHeading(card)}\n\`\`\`python\n${card.body}\n\`\`\`${result}`;
	}
	return `${cardHeading(card)} — ${fileLine(card)}`;
}

/** "Price" → its column, by name (any case) or id. */
export function findColumn(cols: Column[], name: string): Column | undefined {
	const n = name.trim().toLowerCase();
	return cols.find((c) => c.name.toLowerCase() === n) ?? cols.find((c) => c.id === n);
}

export function unknownColumn(name: string, cols: Column[]): Error {
	return new Error(
		`No column "${name}". Columns: ${cols.map((c) => c.name).join(', ')}. Add one with notebook_table_columns.`
	);
}

/**
 * `row_id: Price=79.99; In stock=yes` lines into update ops, values parsed
 * by column type and merged into the row's current cells.
 */
export function parseUpdates(
	text: string,
	cols: Column[],
	current: Map<string, Record<string, unknown>>
): RowOp[] {
	const ops: RowOp[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const colon = line.indexOf(':');
		if (colon < 0) throw new Error(`"${line.trim()}" isn't "row_id: Column=value".`);
		const rowId = line.slice(0, colon).trim();
		const cells = current.get(rowId);
		if (!cells) throw new Error(`No row ${rowId} in this card.`);
		const next = { ...cells };
		for (const part of line.slice(colon + 1).split(';')) {
			if (!part.trim()) continue;
			const eq = part.indexOf('=');
			if (eq < 0) throw new Error(`"${part.trim()}" isn't "Column=value".`);
			const name = part.slice(0, eq);
			const col = findColumn(cols, name);
			if (!col) throw unknownColumn(name.trim(), cols);
			const value = parseCell(col, part.slice(eq + 1));
			if (value === '' || value === undefined) delete next[col.id];
			else next[col.id] = value;
		}
		current.set(rowId, next);
		ops.push({ op: 'update', row_id: rowId, cells: JSON.stringify(next) });
	}
	return ops;
}

/** Checklist `items`: one per line, `[x] ` for done. */
export function checklistRows(items: string): string[] {
	return items
		.split(/\r?\n/)
		.map((l) => l.replace(/^\s*[-*]\s*/, ''))
		.filter((l) => l.trim())
		.map((l) => {
			const m = /^\s*\[([ xX✓])\]\s*(.*)$/.exec(l);
			return JSON.stringify(
				m ? { text: m[2].trim(), done: m[1] !== ' ' } : { text: l.trim(), done: false }
			);
		});
}

/** A table card's meta and rows from CSV (typed `Name:type` headers allowed). */
export function tableFromCsv(csv: string): { meta: string; rows: string[] } {
	const t = rowsFromCsv(csv);
	if (t.columns.length === 0) throw new Error('The CSV needs a header row.');
	return {
		meta: JSON.stringify({ columns: t.columns }),
		rows: t.rows.map((r) => JSON.stringify(r))
	};
}
