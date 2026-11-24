import { describe, it, expect } from 'vitest';
import {
	compare,
	formatCell,
	inferType,
	isValid,
	parseCell,
	total,
	columnsOf,
	type Column
} from './columns';

const col = (type: Column['type'], extra: Partial<Column> = {}): Column => ({
	id: 'c',
	name: 'C',
	type,
	...extra
});

describe('parseCell', () => {
	it('parses numbers with signs, separators and symbols', () => {
		expect(parseCell(col('number'), '1,234.5')).toBe(1234.5);
		expect(parseCell(col('currency'), '$79.99')).toBe(79.99);
		expect(parseCell(col('currency'), 'USD 12')).toBe(12);
		expect(parseCell(col('number'), '-3')).toBe(-3);
	});

	it('keeps what does not parse as text', () => {
		expect(parseCell(col('number'), 'about 5')).toBe('about 5');
		expect(parseCell(col('date'), 'soon')).toBe('soon');
		expect(parseCell(col('checkbox'), 'maybe')).toBe('maybe');
	});

	it('parses dates to ISO and refuses impossible ones', () => {
		expect(parseCell(col('date'), '2026-03-04')).toBe('2026-03-04');
		expect(parseCell(col('date'), '2026-02-30')).toBe('2026-02-30');
		expect(isValid(col('date'), parseCell(col('date'), '2026-02-30'))).toBe(true);
		expect(parseCell(col('date'), 'March 4, 2026')).toBe('2026-03-04');
	});

	it('parses checkboxes and fixes bare www links', () => {
		expect(parseCell(col('checkbox'), 'yes')).toBe(true);
		expect(parseCell(col('checkbox'), '')).toBe(false);
		expect(parseCell(col('url'), 'www.example.com')).toBe('https://www.example.com');
	});
});

describe('formatCell', () => {
	it('formats currency in the column currency', () => {
		expect(formatCell(col('currency', { currency: 'USD' }), 5)).toMatch(/5\.00/);
	});

	it('shows an invalid value as it was typed', () => {
		expect(formatCell(col('number'), 'about 5')).toBe('about 5');
		expect(isValid(col('number'), 'about 5')).toBe(false);
	});

	it('shows a ticked checkbox as a tick', () => {
		expect(formatCell(col('checkbox'), true)).toBe('✓');
		expect(formatCell(col('checkbox'), false)).toBe('');
	});
});

describe('compare and total', () => {
	it('sorts numbers numerically with blanks last', () => {
		const c = col('number');
		expect([3, '', 10, 2].sort((a, b) => compare(c, a, b))).toEqual([2, 3, 10, '']);
	});

	it('sorts status by its options order', () => {
		const c = col('status', { options: ['todo', 'doing', 'done'] });
		expect(['done', 'todo', 'doing'].sort((a, b) => compare(c, a, b))).toEqual([
			'todo',
			'doing',
			'done'
		]);
	});

	it('totals numbers and ignores text', () => {
		expect(total(col('currency'), [1.5, 'x', 2])).toBe(3.5);
		expect(total(col('text'), [1])).toBeNull();
	});
});

describe('inferType', () => {
	it('recognises each kind of column', () => {
		expect(inferType(['https://a.com', 'http://b.org'])).toBe('url');
		expect(inferType(['$5', '$7.50'])).toBe('currency');
		expect(inferType(['5', '7.5'])).toBe('number');
		expect(inferType(['2026-01-01', '2026-02-02'])).toBe('date');
		expect(inferType(['yes', 'no'])).toBe('checkbox');
		expect(inferType(['5', 'five'])).toBe('text');
		expect(inferType(['', ''])).toBe('text');
	});
});

describe('columnsOf', () => {
	it('drops malformed columns and defaults unknown types to text', () => {
		expect(
			columnsOf({ columns: [{ id: 'a', name: 'A', type: 'weird' }, null, { name: 'no id' }] })
		).toEqual([{ id: 'a', name: 'A', type: 'text' }]);
		expect(columnsOf({})).toEqual([]);
	});
});
