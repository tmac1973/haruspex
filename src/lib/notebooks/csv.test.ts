import { describe, it, expect } from 'vitest';
import { columnId, parseCsv, rowsFromCsv, splitHeader, writeCsv } from './csv';

describe('parseCsv / writeCsv', () => {
	it('round-trips quotes, commas, newlines and a BOM', () => {
		const rows = [
			['Name', 'Note'],
			['A, B', 'said "hi"'],
			['multi', 'line\none'],
			['', ' padded ']
		];
		const text = writeCsv(rows);
		expect(parseCsv('﻿' + text)).toEqual(rows);
	});

	it('handles CRLF and skips blank lines', () => {
		expect(parseCsv('a,b\r\n\r\n1,2\r\n')).toEqual([
			['a', 'b'],
			['1', '2']
		]);
	});
});

describe('headers', () => {
	it('splits a typed header and leaves an unknown type in the name', () => {
		expect(splitHeader('Price:currency')).toEqual({ name: 'Price', type: 'currency' });
		expect(splitHeader('Time: 10:30')).toEqual({ name: 'Time: 10:30', type: null });
	});

	it('makes unique ids', () => {
		const taken = new Set<string>();
		expect(columnId('Price ($)', taken)).toBe('price');
		expect(columnId('price', taken)).toBe('price_2');
		expect(columnId('!!!', taken)).toBe('col');
	});
});

describe('rowsFromCsv', () => {
	it('uses typed headers and infers the rest', () => {
		const t = rowsFromCsv(
			'Name,Price:currency,Link,Battery (h)\nSoundcore,$79.99,https://a.com,24\nJBL,129,https://b.com,12'
		);
		expect(t.columns.map((c) => c.type)).toEqual(['text', 'currency', 'url', 'number']);
		expect(t.rows[0]).toEqual({
			name: 'Soundcore',
			price: 79.99,
			link: 'https://a.com',
			battery_h: 24
		});
	});

	it('reuses existing columns by name', () => {
		const t = rowsFromCsv('price,name\n5,x', [
			{ id: 'n', name: 'Name', type: 'text' },
			{ id: 'p', name: 'Price', type: 'number' }
		]);
		expect(t.columns.map((c) => c.id)).toEqual(['p', 'n']);
		expect(t.rows).toEqual([{ p: 5, n: 'x' }]);
	});

	it('leaves empty cells out', () => {
		expect(rowsFromCsv('a,b\n1,').rows).toEqual([{ a: 1 }]);
	});
});
