/**
 * CSV in and out of notebook tables (RFC 4180: quoted fields, doubled
 * quotes, newlines inside quotes, a leading BOM ignored). Also how agents
 * hand a table over: a header row, where `Name:type` sets a column's type.
 */
import {
	COLUMN_TYPES,
	inferType,
	parseCell,
	type Column,
	type ColumnType
} from '#lib/notebooks/columns.ts';

/** Parse CSV text into rows of fields. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
	const src = text.replace(/^\uFEFF/, '');
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let i = 0;
	const endRow = () => {
		row.push(field);
		field = '';
		if (!(row.length === 1 && row[0] === '')) rows.push(row);
		row = [];
	};
	while (i < src.length) {
		const ch = src[i];
		if (quoted) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
			} else {
				field += ch;
			}
			i++;
			continue;
		}
		if (ch === '"' && field === '') {
			quoted = true;
		} else if (ch === ',') {
			row.push(field);
			field = '';
		} else if (ch === '\r') {
			if (src[i + 1] === '\n') i++;
			endRow();
		} else if (ch === '\n') {
			endRow();
		} else {
			field += ch;
		}
		i++;
	}
	if (field !== '' || row.length > 0) endRow();
	return rows;
}

function quote(field: string): string {
	return /[",\r\n]/.test(field) || /^\s|\s$/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/** Rows of fields as CSV text, CRLF-free (one `\n` per row). */
export function writeCsv(rows: string[][]): string {
	return rows.map((r) => r.map(quote).join(',')).join('\n');
}

/** A short column id from a name, unique among `taken`. */
export function columnId(name: string, taken: Set<string>): string {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.slice(0, 24) || 'col';
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
	taken.add(id);
	return id;
}

/** `Price:currency` → name Price, type currency; an unknown type stays in the name. */
export function splitHeader(header: string): { name: string; type: ColumnType | null } {
	const m = /^(.*?):\s*([a-z]+)\s*$/i.exec(header.trim());
	if (m && (COLUMN_TYPES as readonly string[]).includes(m[2].toLowerCase())) {
		return { name: m[1].trim() || 'Column', type: m[2].toLowerCase() as ColumnType };
	}
	return { name: header.trim(), type: null };
}

export interface TableData {
	columns: Column[];
	/** Each row's cells keyed by column id, values parsed by column type. */
	rows: Record<string, unknown>[];
}

/**
 * A table from CSV with a header row. Columns take the type the header
 * names, else the given `columns` by name, else one inferred from the
 * first 50 values.
 */
export function rowsFromCsv(csv: string, columns?: Column[]): TableData {
	const parsed = parseCsv(csv);
	if (parsed.length === 0) return { columns: columns ?? [], rows: [] };
	const [header, ...body] = parsed;
	const taken = new Set<string>();
	const cols: Column[] = header.map((h, i) => {
		const { name, type } = splitHeader(h || `Column ${i + 1}`);
		const known = columns?.find((c) => c.name.toLowerCase() === name.toLowerCase());
		if (known) {
			taken.add(known.id);
			return type && type !== known.type ? { ...known, type } : known;
		}
		const sample = body.slice(0, 50).map((r) => r[i] ?? '');
		return {
			id: columnId(name || `Column ${i + 1}`, taken),
			name,
			type: type ?? inferType(sample)
		};
	});
	const rows = body.map((r) => {
		const cells: Record<string, unknown> = {};
		cols.forEach((c, i) => {
			const raw = r[i] ?? '';
			if (raw !== '') cells[c.id] = parseCell(c, raw);
		});
		return cells;
	});
	return { columns: cols, rows };
}
