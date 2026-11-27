/**
 * How the notebook tools show notebooks to a model and read its edits:
 * outlines, tables as CSV with a `row_id` column, and the small text
 * formats (`row_id: Column=value`, checklist `[x]` lines) the tools take.
 */
import * as api from '#lib/notebooks/api.ts';
import type { NotebookCard, RowOp } from '#lib/notebooks/api.ts';
import { columnsOf, parseCell, rawCell, type Column } from '#lib/notebooks/columns.ts';
import { parseCsv, rowsFromCsv, writeCsv } from '#lib/notebooks/csv.ts';

const OUTLINE_TEXT = 300;
const OUTLINE_ROWS = 10;
export const PAGE_ROWS = 100;
const CHECKLIST_COLUMNS: Column[] = [
	{ id: 'text', name: 'text', type: 'text' },
	{ id: 'done', name: 'done', type: 'checkbox' },
	{ id: 'note', name: 'note', type: 'text' }
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

/** The start of a long text or code body, saying how to read the rest. */
function bodyStart(card: NotebookCard): { start: string; more: string } {
	if (card.body.length <= OUTLINE_TEXT) return { start: card.body, more: '' };
	const left = card.body.length - OUTLINE_TEXT;
	return {
		start: `${card.body.slice(0, OUTLINE_TEXT)}…`,
		more: `\n…${left} more characters; notebook_read with card="${card.id}" for all`
	};
}

/** One card, as the outline shows it. */
export function cardOutline(card: NotebookCard): string {
	const head = cardHeading(card);
	switch (card.kind) {
		case 'text': {
			const { start, more } = bodyStart(card);
			return `${head}\n${start || '(empty)'}${more}`;
		}
		case 'table':
		case 'checklist': {
			const more =
				card.row_count > OUTLINE_ROWS
					? `\n…${card.row_count - OUTLINE_ROWS} more rows; notebook_read with card="${card.id}" for all`
					: '';
			return `${head} — ${card.row_count} rows\n${rowsToCsv(card, card.rows.slice(0, OUTLINE_ROWS))}${more}`;
		}
		case 'python': {
			const { start, more } = bodyStart(card);
			return `${head}\n\`\`\`python\n${start}\n\`\`\`${more}`;
		}
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

const JSON_HINT =
	'If ";" is part of a value, pass update as JSON: {"row_id": {"Column": "value"}}.';

/** Could this text be a column name the model meant, rather than part of a value? */
function looksLikeColumnName(text: string): boolean {
	return text.length <= 60 && /^[\p{L}\p{N} _\-/().#%&]+$/u.test(text);
}

function setCell(next: Record<string, unknown>, col: Column, raw: string): void {
	const value = parseCell(col, raw);
	if (value === '' || value === undefined) delete next[col.id];
	else next[col.id] = value;
}

/**
 * `Price=79.99; In stock=yes` into column/value pairs. A `;` starts a new
 * pair only when a column name and `=` follow it, so values may hold `;`
 * and `=` (shell commands, prose).
 */
function splitAssignments(text: string, cols: Column[], rowId: string): [Column, string][] {
	const pairs: [Column, string][] = [];
	for (const part of text.split(';')) {
		if (!part.trim()) continue;
		const eq = part.indexOf('=');
		const name = eq < 0 ? '' : part.slice(0, eq).trim();
		const col = eq < 0 ? undefined : findColumn(cols, name);
		if (col) {
			pairs.push([col, part.slice(eq + 1)]);
			continue;
		}
		const last = pairs[pairs.length - 1];
		if (!last) {
			if (eq < 0) throw new Error(`Row ${rowId}: "${part.trim()}" isn't "Column=value".`);
			throw unknownColumn(name, cols);
		}
		if (eq >= 0 && looksLikeColumnName(name)) {
			throw new Error(
				`Row ${rowId}: "${name}" after a ";" is no column. Columns: ${cols.map((c) => c.name).join(', ')}. ${JSON_HINT}`
			);
		}
		last[1] += `;${part}`;
	}
	return pairs;
}

/** `{"row_id": {"Column": value}}`, as the model may send `update`. */
function jsonUpdates(value: unknown): [string, Record<string, unknown>][] | null {
	let v = value;
	if (typeof v === 'string') {
		if (!v.trim().startsWith('{')) return null;
		try {
			v = JSON.parse(v);
		} catch (e) {
			throw new Error(`update isn't valid JSON: ${e instanceof Error ? e.message : String(e)}`, {
				cause: e
			});
		}
	}
	if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
	return Object.entries(v as Record<string, unknown>).map(([id, cells]) => {
		if (!cells || typeof cells !== 'object' || Array.isArray(cells)) {
			throw new Error(`Row ${id}: give its cells as {"Column": "value"}.`);
		}
		return [id.trim(), cells as Record<string, unknown>];
	});
}

/**
 * `row_id: Price=79.99; In stock=yes` lines (or the same as JSON,
 * `{"row_id": {"Price": 79.99}}`) into update ops, values parsed by column
 * type and merged into the row's current cells.
 */
export function parseUpdates(
	update: unknown,
	cols: Column[],
	current: Map<string, Record<string, unknown>>
): RowOp[] {
	const rows: [string, [Column, string][]][] = [];
	const json = jsonUpdates(update);
	if (json) {
		for (const [rowId, cells] of json) {
			const pairs = Object.entries(cells).map(([name, v]): [Column, string] => {
				const col = findColumn(cols, name);
				if (!col) throw unknownColumn(name.trim(), cols);
				return [col, v == null ? '' : typeof v === 'string' ? v : String(v)];
			});
			rows.push([rowId, pairs]);
		}
	} else {
		const text = typeof update === 'string' ? update : '';
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const colon = line.indexOf(':');
			if (colon < 0) throw new Error(`"${line.trim()}" isn't "row_id: Column=value".`);
			const rowId = line.slice(0, colon).trim();
			rows.push([rowId, splitAssignments(line.slice(colon + 1), cols, rowId)]);
		}
	}
	const ops: RowOp[] = [];
	for (const [rowId, pairs] of rows) {
		const cells = current.get(rowId);
		if (!cells) throw new Error(`No row ${rowId} in this card.`);
		const next = { ...cells };
		for (const [col, raw] of pairs) setCell(next, col, raw);
		current.set(rowId, next);
		ops.push({ op: 'update', row_id: rowId, cells: JSON.stringify(next) });
	}
	return ops;
}

/**
 * Refuse CSV rows with more fields than the header: an unquoted comma in a
 * value split it, and adding it would shift text into the wrong columns.
 * Trailing empty fields (a trailing comma) are fine.
 */
export function checkCsvWidths(header: string[], body: string[][]): void {
	const bad: string[] = [];
	body.forEach((fields, i) => {
		const extra = fields.slice(header.length);
		if (extra.some((f) => f.trim() !== '')) {
			bad.push(`row ${i + 1} has ${fields.length} fields`);
		}
	});
	if (bad.length === 0) return;
	const shown = bad.length > 5 ? [...bad.slice(0, 5), `${bad.length - 5} more`] : bad;
	throw new Error(
		`The header has ${header.length} columns, but ${shown.join(', ')}. A value with a comma needs quotes: "Paris, France". Nothing was changed.`
	);
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
	const [header, ...body] = parseCsv(csv);
	if (header) checkCsvWidths(header, body);
	const t = rowsFromCsv(csv);
	if (t.columns.length === 0) throw new Error('The CSV needs a header row.');
	return {
		meta: JSON.stringify({ columns: t.columns }),
		rows: t.rows.map((r) => JSON.stringify(r))
	};
}
