import { CHART_TYPES } from '#lib/slides/types.ts';
import type { ChartType, SlideChart } from '#lib/slides/types.ts';

/**
 * A slide's `chart` and `table` as a model sends them, read into the shapes
 * the builders take. Forgiving where the meaning is plain ("12%" is 12, rows
 * of objects are a header and its rows, no chart type is a bar chart);
 * otherwise a message naming the slide and what to change.
 */

/** The most a chart or table can hold and still be read on a slide. */
export const MAX_CHART_LABELS = 24;
export const MAX_CHART_SERIES = 8;
export const MAX_TABLE_COLUMNS = 8;
export const MAX_TABLE_ROWS = 25;

const CHART_ALIASES: Record<string, ChartType> = {
	column: 'bar',
	columns: 'bar',
	bars: 'bar',
	lines: 'line',
	donut: 'doughnut'
};

/** A JSON string is the value it encodes; anything else is left alone. */
function parsed(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** A number, or one written with separators, a unit or a percent sign. */
function readNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string') return null;
	const bare = value.replace(/[\s,%$€£]/g, '');
	if (bare === '') return null;
	const n = Number(bare);
	return Number.isFinite(n) ? n : null;
}

/** A cell or label as text; null for something that isn't one. */
function readText(value: unknown): string | null {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}

function readChartType(raw: unknown): ChartType | null {
	if (raw === undefined) return 'bar';
	const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	const type = CHART_ALIASES[name] ?? name;
	return (CHART_TYPES as readonly string[]).includes(type) ? (type as ChartType) : null;
}

/** The series a chart lists: its `series`, or a lone `values` list as one. */
function rawSeries(chart: Record<string, unknown>): unknown[] {
	const series = parsed(chart.series);
	if (Array.isArray(series)) {
		// A bare list of numbers is one series.
		return series.every((v) => readNumber(v) !== null) ? [{ values: series }] : series;
	}
	return Array.isArray(chart.values) ? [{ values: chart.values }] : [];
}

function readSeries(
	raw: unknown,
	i: number,
	labels: number
): { name: string; values: number[] } | string {
	if (!raw || typeof raw !== 'object') return 'each series must be an object with name and values.';
	const { name: rawName, values: rawValues } = raw as Record<string, unknown>;
	const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : `Series ${i + 1}`;
	const values = parsed(rawValues);
	if (!Array.isArray(values)) return `series "${name}" has no values list.`;
	if (values.length !== labels) {
		return `series "${name}" has ${values.length} values for ${labels} labels; give one value per label.`;
	}
	const numbers: number[] = [];
	for (const v of values) {
		const n = readNumber(v);
		if (n === null) return `${JSON.stringify(v)} in series "${name}" is not a number.`;
		numbers.push(n);
	}
	return { name, values: numbers };
}

/** A chart's labels as text, or why they won't do. */
function readLabels(raw: unknown): string[] | string {
	const labels = parsed(raw);
	if (!Array.isArray(labels) || labels.length === 0) {
		return 'it needs labels: one per bar, point or slice.';
	}
	if (labels.length > MAX_CHART_LABELS) {
		return `it has ${labels.length} labels, and ${MAX_CHART_LABELS} at most fit. Group them or split the chart.`;
	}
	return labels.map((l) => readText(l) ?? JSON.stringify(l));
}

/** The chart, or why it can't be drawn (without the slide's name). */
function readChart(raw: unknown): SlideChart | string {
	const chart = parsed(raw);
	if (!chart || typeof chart !== 'object' || Array.isArray(chart)) {
		return 'it must be an object with type, labels and series.';
	}
	const c = chart as Record<string, unknown>;
	const type = readChartType(c.type);
	if (!type) return `type must be one of ${CHART_TYPES.join(', ')}.`;
	const labels = readLabels(c.labels);
	if (typeof labels === 'string') return labels;
	let raws = rawSeries(c);
	if (raws.length === 0) return 'it needs series: each a name and one value per label.';
	if (raws.length > MAX_CHART_SERIES) {
		return `it has ${raws.length} series, and ${MAX_CHART_SERIES} at most fit.`;
	}
	// A pie shows one series.
	if (type === 'pie' || type === 'doughnut') raws = raws.slice(0, 1);
	const series: SlideChart['series'] = [];
	for (const [i, r] of raws.entries()) {
		const s = readSeries(r, i, labels.length);
		if (typeof s === 'string') return s;
		series.push(s);
	}
	if ((type === 'pie' || type === 'doughnut') && series[0].values.some((v) => v < 0)) {
		return `a ${type} chart can't show negative values; use a bar chart.`;
	}
	return { type, labels, series };
}

/** Rows of objects as a header (the first one's keys) and its rows. */
function rowsOf(table: unknown[]): unknown[] {
	const first = table[0];
	if (!first || typeof first !== 'object' || Array.isArray(first)) return table;
	const keys = Object.keys(first);
	return [
		keys,
		...table.map((row) =>
			row && typeof row === 'object' ? keys.map((k) => (row as Record<string, unknown>)[k]) : row
		)
	];
}

/** The table, header first and every row padded to one width, or why it
 *  can't be drawn (without the slide's name). */
function readTable(raw: unknown): string[][] | string {
	const table = parsed(raw);
	if (!Array.isArray(table)) return 'it must be a list of rows, the header first.';
	const rows = rowsOf(table);
	if (rows.length < 2) return 'it needs a header row and at least one row under it.';
	if (rows.length > MAX_TABLE_ROWS) {
		return `it has ${rows.length} rows, and ${MAX_TABLE_ROWS} at most fit. Split it across slides.`;
	}
	const cells: string[][] = [];
	for (const row of rows) {
		if (!Array.isArray(row)) return 'each row must be a list of cells.';
		const texts = row.map(readText);
		if (texts.some((t) => t === null)) return 'each cell must be text or a number.';
		cells.push(texts as string[]);
	}
	const width = Math.max(...cells.map((r) => r.length));
	if (width > MAX_TABLE_COLUMNS) {
		return `it has ${width} columns, and ${MAX_TABLE_COLUMNS} at most fit. Drop some, or split it.`;
	}
	return cells.map((r) => [...r, ...Array<string>(width - r.length).fill('')]);
}

/**
 * Read a slide's `chart` and `table` in place, dropping empty ones. Returns
 * a message for the model when one can't be read, or when the slide has more
 * than one of image, chart and table; null when all is well.
 */
export function prepareVisuals(slide: Record<string, unknown>, num: number): string | null {
	for (const key of ['chart', 'table'] as const) {
		const value = slide[key];
		if (value === undefined || value === null || value === '') {
			delete slide[key];
			continue;
		}
		const read = key === 'chart' ? readChart(value) : readTable(value);
		if (typeof read === 'string') return `Slide ${num}'s ${key} can't be drawn: ${read}`;
		slide[key] = read;
	}
	const visuals = (['image', 'chart', 'table'] as const).filter((k) => slide[k] !== undefined);
	if (visuals.length > 1) {
		return (
			`Slide ${num} has ${visuals.join(' and ')}, and a slide shows one of image, chart ` +
			`and table. Put the others on slides of their own.`
		);
	}
	return null;
}

/** The words a chart or table shows, once `prepareVisuals` has read them. */
export function visualTexts(slide: Record<string, unknown>): string[] {
	const chart = slide.chart as SlideChart | undefined;
	const table = slide.table as string[][] | undefined;
	return [
		...(chart ? [...chart.labels, ...chart.series.map((s) => s.name)] : []),
		...(table ?? []).flat()
	];
}
