import { describe, it, expect } from 'vitest';
import { MAX_CHART_LABELS, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, prepareVisuals } from './visuals';

/** `slide` after `prepareVisuals`, or the error it gave. */
function prepared(slide: Record<string, unknown>): Record<string, unknown> | string {
	const copy = { ...slide };
	return prepareVisuals(copy, 3) ?? copy;
}

const chartOf = (chart: unknown) => prepared({ title: 'T', chart });
const tableOf = (table: unknown) => prepared({ title: 'T', table });

describe('a chart', () => {
	it('is read as it is when it is already right', () => {
		const chart = {
			type: 'line',
			labels: ['Q1', 'Q2'],
			series: [
				{ name: 'Revenue', values: [10, 12] },
				{ name: 'Costs', values: [8, 9] }
			]
		};
		expect(chartOf(chart)).toEqual({ title: 'T', chart });
	});

	it('reads numbers written as people write them', () => {
		const out = chartOf({
			type: 'bar',
			labels: ['a', 'b', 'c', 'd'],
			series: [{ name: 'x', values: ['12%', '1,200', '$40', ' -3.5 '] }]
		}) as { chart: { series: { values: number[] }[] } };
		expect(out.chart.series[0].values).toEqual([12, 1200, 40, -3.5]);
	});

	it('takes a JSON string, a missing type, a type alias, and labels as text', () => {
		const out = chartOf(JSON.stringify({ labels: [2024, 2025], series: [{ values: [1, 2] }] })) as {
			chart: unknown;
		};
		expect(out.chart).toEqual({
			type: 'bar',
			labels: ['2024', '2025'],
			series: [{ name: 'Series 1', values: [1, 2] }]
		});
		const donut = chartOf({ type: 'Donut', labels: ['a'], series: [{ values: [1] }] }) as {
			chart: { type: string };
		};
		expect(donut.chart.type).toBe('doughnut');
	});

	it('takes a lone values list, or a bare list of numbers, as one series', () => {
		for (const chart of [
			{ labels: ['a', 'b'], values: [1, 2] },
			{ labels: ['a', 'b'], series: [1, 2] }
		]) {
			const out = chartOf(chart) as { chart: { series: unknown[] } };
			expect(out.chart.series).toEqual([{ name: 'Series 1', values: [1, 2] }]);
		}
	});

	it('keeps only the first series of a pie', () => {
		const out = chartOf({
			type: 'pie',
			labels: ['a', 'b'],
			series: [
				{ name: 'x', values: [1, 2] },
				{ name: 'y', values: [3, 4] }
			]
		}) as { chart: { series: unknown[] } };
		expect(out.chart.series).toEqual([{ name: 'x', values: [1, 2] }]);
	});

	it.each([
		['not an object', ['a'], /^Slide 3's chart can't be drawn: it must be an object/],
		[
			'an unknown type',
			{ type: 'radar', labels: ['a'], values: [1] },
			/type must be one of bar, line, pie, doughnut/
		],
		['no labels', { series: [{ values: [1] }] }, /it needs labels/],
		['no series', { labels: ['a'] }, /it needs series/],
		[
			'too many labels',
			{
				labels: Array(MAX_CHART_LABELS + 1).fill('x'),
				values: Array(MAX_CHART_LABELS + 1).fill(1)
			},
			/25 labels, and 24 at most fit/
		],
		[
			'a series of the wrong length',
			{ labels: ['a', 'b'], series: [{ name: 'Sales', values: [1, 2, 3] }] },
			/series "Sales" has 3 values for 2 labels/
		],
		[
			'a value that is not a number',
			{ labels: ['a'], series: [{ name: 'Sales', values: ['lots'] }] },
			/"lots" in series "Sales" is not a number/
		],
		[
			'a negative slice',
			{ type: 'pie', labels: ['a', 'b'], values: [3, -1] },
			/a pie chart can't show negative values; use a bar chart/
		]
	])('is refused when it has %s', (_label, chart, message) => {
		expect(chartOf(chart)).toMatch(message);
	});
});

describe('a table', () => {
	it('pads short rows and reads numbers and blanks as text', () => {
		const out = tableOf([
			['Name', 'Age', 'City'],
			['Ada', 36],
			['Alan', null, ' London ']
		]) as { table: string[][] };
		expect(out.table).toEqual([
			['Name', 'Age', 'City'],
			['Ada', '36', ''],
			['Alan', '', 'London']
		]);
	});

	it('reads rows of objects as a header and its rows', () => {
		const out = tableOf([
			{ Name: 'Ada', Age: 36 },
			{ Name: 'Alan', Age: 41 }
		]) as { table: string[][] };
		expect(out.table).toEqual([
			['Name', 'Age'],
			['Ada', '36'],
			['Alan', '41']
		]);
	});

	it('takes a JSON string', () => {
		const out = tableOf('[["a","b"],["1","2"]]') as { table: string[][] };
		expect(out.table).toEqual([
			['a', 'b'],
			['1', '2']
		]);
	});

	it.each([
		['not a list', { a: 1 }, /it must be a list of rows/],
		['only a header', [['a', 'b']], /a header row and at least one row/],
		['a row that is not a list', [['a'], 'b'], /each row must be a list of cells/],
		['a cell that is an object', [['a'], [{ b: 1 }]], /each cell must be text or a number/],
		[
			'too many columns',
			[Array(MAX_TABLE_COLUMNS + 1).fill('h'), ['x']],
			/9 columns, and 8 at most fit/
		],
		['too many rows', Array(MAX_TABLE_ROWS + 1).fill(['x']), /26 rows, and 25 at most fit/]
	])('is refused when it is %s', (_label, table, message) => {
		expect(tableOf(table)).toMatch(message);
	});
});

describe('one visual a slide', () => {
	it('drops an empty chart or table', () => {
		expect(prepared({ title: 'T', chart: '', table: null })).toEqual({ title: 'T' });
	});

	it('refuses an image with a chart, or a chart with a table', () => {
		const chart = { labels: ['a'], values: [1] };
		expect(prepared({ title: 'T', image: 'a.png', chart })).toBe(
			'Slide 3 has image and chart, and a slide shows one of image, chart and table. ' +
				'Put the others on slides of their own.'
		);
		expect(prepared({ title: 'T', chart, table: [['a'], ['b']] })).toMatch(
			/^Slide 3 has chart and table/
		);
	});
});
