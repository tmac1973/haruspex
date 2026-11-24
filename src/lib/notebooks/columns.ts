/**
 * Table column types: how a typed value is parsed from what someone typed,
 * shown, sorted and totalled. A value that doesn't parse is kept as the text
 * it was (and shown tinted), never thrown away.
 */

export const COLUMN_TYPES = [
	'text',
	'number',
	'currency',
	'url',
	'date',
	'checkbox',
	'status'
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface Column {
	id: string;
	name: string;
	type: ColumnType;
	/** Currency columns: the ISO code, e.g. USD. */
	currency?: string;
	/** Status columns: the allowed values, in order. */
	options?: string[];
}

export const DEFAULT_STATUS = ['todo', 'doing', 'done'];

export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
	text: 'Text',
	number: 'Number',
	currency: 'Currency',
	url: 'Link',
	date: 'Date',
	checkbox: 'Checkbox',
	status: 'Status'
};

/** The locale's currency guess, for a new currency column. */
export function defaultCurrency(): string {
	try {
		const region = new Intl.Locale(navigator.language).maximize().region ?? 'US';
		const euro = ['DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'AT', 'IE', 'PT', 'FI', 'GR'];
		if (euro.includes(region)) return 'EUR';
		return { GB: 'GBP', CA: 'CAD', AU: 'AUD', JP: 'JPY', IN: 'INR', CH: 'CHF' }[region] ?? 'USD';
	} catch {
		return 'USD';
	}
}

/** A number in `raw`, allowing currency signs, thousands commas and spaces. */
function parseNumber(raw: string): number | null {
	const t = raw
		.trim()
		.replace(/^[A-Z]{3}\s*/i, '')
		.replace(/[$€£¥₹\s]/g, '')
		.replace(/,(?=\d{3}(\D|$))/g, '');
	if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(t)) return null;
	const n = Number(t.replace('%', ''));
	return Number.isFinite(n) ? n : null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An ISO date (YYYY-MM-DD) from `raw`, or null. */
function parseDate(raw: string): string | null {
	const t = raw.trim();
	if (ISO_DATE.test(t)) {
		const d = new Date(`${t}T00:00:00Z`);
		return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? null : t;
	}
	// Words or slashes ("Mar 3 2026", "2026/03/03"): only with a 4-digit year.
	if (!/\d{4}/.test(t)) return null;
	const d = new Date(t);
	if (Number.isNaN(d.getTime())) return null;
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseBool(raw: string): boolean | null {
	const t = raw.trim().toLowerCase();
	if (['true', 'yes', 'y', 'x', '✓', '✔', '1', 'done', '[x]'].includes(t)) return true;
	if (['false', 'no', 'n', '', '0', '[ ]'].includes(t)) return false;
	return null;
}

function looksLikeUrl(raw: string): boolean {
	return /^(https?:\/\/|www\.)\S+$/i.test(raw.trim());
}

/**
 * `raw` as `column` stores it: a number, ISO date, boolean, URL or text.
 * What doesn't parse comes back as the trimmed text.
 */
export function parseCell(column: Column, raw: string): unknown {
	const t = raw.trim();
	switch (column.type) {
		case 'number':
		case 'currency':
			return parseNumber(t) ?? t;
		case 'date':
			return parseDate(t) ?? t;
		case 'checkbox':
			return parseBool(t) ?? t;
		case 'url':
			return /^www\./i.test(t) ? `https://${t}` : t;
		case 'status':
		case 'text':
			return t;
	}
}

/** Whether a stored value is what the column type expects. */
export function isValid(column: Column, value: unknown): boolean {
	if (value === undefined || value === null || value === '') return true;
	switch (column.type) {
		case 'number':
		case 'currency':
			return typeof value === 'number';
		case 'date':
			return typeof value === 'string' && ISO_DATE.test(value);
		case 'checkbox':
			return typeof value === 'boolean';
		case 'url':
			return typeof value === 'string' && /^https?:\/\//i.test(value);
		default:
			return true;
	}
}

/** A value as the table shows it. */
export function formatCell(column: Column, value: unknown): string {
	if (value === undefined || value === null) return '';
	if (!isValid(column, value)) return String(value);
	switch (column.type) {
		case 'number':
			return (value as number).toLocaleString(undefined, { maximumFractionDigits: 6 });
		case 'currency':
			try {
				return (value as number).toLocaleString(undefined, {
					style: 'currency',
					currency: column.currency || 'USD'
				});
			} catch {
				return (value as number).toFixed(2);
			}
		case 'date': {
			const d = new Date(`${value as string}T00:00:00`);
			return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
		}
		case 'checkbox':
			return value ? '✓' : '';
		default:
			return String(value);
	}
}

/** A value as an editor or CSV shows it: no thousands separators or symbols. */
export function rawCell(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	return String(value);
}

/** Sort order for two values of a column; empty values go last. */
export function compare(column: Column, a: unknown, b: unknown): number {
	const empty = (v: unknown) => v === undefined || v === null || v === '';
	if (empty(a) || empty(b)) return empty(a) === empty(b) ? 0 : empty(a) ? 1 : -1;
	if (column.type === 'status' && column.options) {
		const ia = column.options.indexOf(String(a));
		const ib = column.options.indexOf(String(b));
		if (ia >= 0 && ib >= 0) return ia - ib;
	}
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'boolean' && typeof b === 'boolean') return Number(b) - Number(a);
	return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** The total of a number or currency column, or null for other types. */
export function total(column: Column, values: unknown[]): number | null {
	if (column.type !== 'number' && column.type !== 'currency') return null;
	return values.reduce<number>((sum, v) => (typeof v === 'number' ? sum + v : sum), 0);
}

/** The likeliest type for a column of sample values (text unless all agree). */
export function inferType(samples: string[]): ColumnType {
	const vals = samples.map((s) => s.trim()).filter((s) => s !== '');
	if (vals.length === 0) return 'text';
	const all = (pred: (s: string) => boolean) => vals.every(pred);
	if (all(looksLikeUrl)) return 'url';
	if (all((s) => /^[$€£¥₹]|^[A-Z]{3}\s?\d/.test(s) && parseNumber(s) !== null)) return 'currency';
	if (all((s) => parseNumber(s) !== null)) return 'number';
	if (all((s) => ISO_DATE.test(s))) return 'date';
	if (all((s) => ['true', 'false', 'yes', 'no', '✓', '✔'].includes(s.toLowerCase())))
		return 'checkbox';
	return 'text';
}

/** A table card's columns from its meta, tolerating anything malformed. */
export function columnsOf(meta: Record<string, unknown>): Column[] {
	const cols = Array.isArray(meta.columns) ? meta.columns : [];
	return cols
		.filter(
			(c): c is Column => !!c && typeof c === 'object' && typeof (c as Column).id === 'string'
		)
		.map((c) => ({
			...c,
			name: typeof c.name === 'string' ? c.name : c.id,
			type: (COLUMN_TYPES as readonly string[]).includes(c.type) ? c.type : 'text'
		}));
}
