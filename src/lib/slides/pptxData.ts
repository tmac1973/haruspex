import type PptxGenJS from 'pptxgenjs';
import type { Box } from '#lib/slides/geometry.ts';
import { fitHeight, wrappedLines } from '#lib/slides/textfit.ts';
import type { Theme } from '#lib/slides/themes.ts';
import type { SlideChart } from '#lib/slides/types.ts';

/**
 * Native charts and tables on a slide. Both stay editable in PowerPoint: a
 * chart carries its data (PowerPoint opens it as a sheet), and a table is
 * cells, not a picture of them.
 */

const at = (box: Box) => ({ x: box.x, y: box.y, w: box.w, h: box.h });

/** Colours for `count` series or slices: the theme's, round again if there
 *  are more. */
function palette(theme: Theme, count: number): string[] {
	return Array.from({ length: count }, (_, i) => theme.series[i % theme.series.length]);
}

/** Draw `chart` filling `box`, in the theme's colours and fonts. */
export function addChart(
	deck: PptxGenJS,
	out: PptxGenJS.Slide,
	theme: Theme,
	box: Box,
	chart: SlideChart
): void {
	const round = chart.type === 'pie' || chart.type === 'doughnut';
	const types: Record<SlideChart['type'], PptxGenJS.CHART_NAME> = {
		bar: deck.ChartType.bar,
		line: deck.ChartType.line,
		pie: deck.ChartType.pie,
		doughnut: deck.ChartType.doughnut
	};
	const data = chart.series.map((s) => ({ name: s.name, labels: chart.labels, values: s.values }));
	const single = chart.series.length === 1;
	const text = { color: theme.muted, fontFace: theme.bodyFont };
	out.addChart(types[chart.type], data, {
		...at(box),
		chartColors: palette(theme, round ? chart.labels.length : chart.series.length),
		chartArea: { fill: { color: theme.background }, roundedCorners: false },
		plotArea: { fill: { color: theme.background } },
		showLegend: round || !single,
		legendPos: 'b',
		legendFontSize: 14,
		legendColor: theme.text,
		legendFontFace: theme.bodyFont,
		catAxisLabelColor: text.color,
		catAxisLabelFontFace: text.fontFace,
		catAxisLabelFontSize: 14,
		catAxisLineColor: theme.line,
		valAxisLabelColor: text.color,
		valAxisLabelFontFace: text.fontFace,
		valAxisLabelFontSize: 12,
		valAxisLineShow: false,
		valGridLine: { color: theme.line, size: 0.5 },
		barDir: 'col',
		barGapWidthPct: 60,
		lineSize: 3,
		lineDataSymbol: 'circle',
		lineDataSymbolSize: 7,
		holeSize: 55,
		// One bar series reads best with its values on the bars; a pie with
		// its percentages on the slices.
		showValue: chart.type === 'bar' && single,
		showPercent: round,
		dataLabelPosition: round ? 'bestFit' : 'outEnd',
		dataLabelColor: round ? 'FFFFFF' : theme.text,
		dataLabelFontSize: 13,
		dataLabelFontFace: theme.bodyFont
	});
}

/** Table text sizes in points, before shrinking: body, by orientation. */
const TABLE_PT = { landscape: 16, portrait: 14 };
/** A cell's inset, top and bottom then left and right, in inches. */
const CELL_PAD = { v: 0.05, h: 0.08 };
const LINE = 1.2;

/** A number as people write one: 12, 1,200, -3.5, 12%, $40, $4.2m, 3bn. */
const NUMERIC = /^[-+]?[$€£]?\s?\d[\d,]*(\.\d+)?\s?(%|[kmb]n?)?$/i;

/** Column widths in proportion to their longest cell, within limits, filling `width`. */
function columnWidths(rows: string[][], width: number): number[] {
	const weights = rows[0].map((_, c) => Math.min(40, Math.max(4, ...rows.map((r) => r[c].length))));
	const total = weights.reduce((a, b) => a + b, 0);
	return weights.map((w) => (width * w) / total);
}

/** Each row's height at `pt` points, in inches: its tallest cell. */
function rowHeights(rows: string[][], widths: number[], pt: number): number[] {
	return rows.map((row) => {
		const lines = Math.max(
			...row.map((cell, c) => wrappedLines(cell, pt, widths[c] - 2 * CELL_PAD.h))
		);
		return (lines * pt * LINE) / 72 + 2 * CELL_PAD.v;
	});
}

/**
 * Draw `rows` (the header first) at the top of `box`, shrunk a step at a time
 * to fit its height. Returns how full the box is at the smallest step it
 * tried, as `fitHeight` does (over 1 means the table spills), and the
 * table's height in inches.
 */
export function addTable(
	out: PptxGenJS.Slide,
	theme: Theme,
	box: Box,
	rows: string[][],
	orientation: 'landscape' | 'portrait'
): { ratio: number; height: number } {
	const widths = columnWidths(rows, box.w);
	const base = TABLE_PT[orientation];
	const { scale, ratio } = fitHeight(
		(s) => rowHeights(rows, widths, base * s).reduce((a, b) => a + b, 0),
		box.h
	);
	const pt = Math.round(base * scale);
	// A column of numbers lines up on the right, its header with it.
	const numeric = rows[0].map((_, c) =>
		rows.slice(1).every((r) => r[c] === '' || NUMERIC.test(r[c]))
	);
	const heights = rowHeights(rows, widths, pt);
	const rule = { type: 'solid' as const, pt: 0.75, color: theme.line };
	const none = { type: 'none' as const };
	const cells: PptxGenJS.TableRow[] = rows.map((row, r) =>
		row.map((text, c) => ({
			text,
			options: {
				bold: r === 0,
				color: r === 0 ? theme.bandText : theme.text,
				fill: { color: r === 0 ? theme.band : r % 2 === 0 ? theme.surface : theme.background },
				align: numeric[c] ? 'right' : 'left',
				border: [none, none, rule, none]
			}
		}))
	);
	out.addTable(cells, {
		x: box.x,
		y: box.y,
		w: box.w,
		colW: widths,
		rowH: heights,
		fontSize: pt,
		fontFace: theme.bodyFont,
		valign: 'middle',
		margin: [CELL_PAD.v, CELL_PAD.h, CELL_PAD.v, CELL_PAD.h],
		autoPage: false
	});
	return { ratio, height: heights.reduce((a, b) => a + b, 0) };
}
