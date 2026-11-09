import { describe, it, expect } from 'vitest';
import { localPageSize, documentOptions } from './looks';

describe('localPageSize', () => {
	it('gives Letter where it is the usual paper and A4 elsewhere', () => {
		expect(localPageSize('en-US')).toBe('letter');
		expect(localPageSize('fr-CA')).toBe('letter');
		expect(localPageSize('es-MX')).toBe('letter');
		expect(localPageSize('en-GB')).toBe('a4');
		expect(localPageSize('de')).toBe('a4');
	});

	it('takes a bare language as where it is mostly spoken', () => {
		expect(localPageSize('en')).toBe('letter');
	});

	it('falls back to A4 for no locale or a broken one', () => {
		expect(localPageSize(undefined)).toBe('a4');
		expect(localPageSize('not a locale!')).toBe('a4');
	});
});

describe('documentOptions', () => {
	it('defaults to the local paper, the plain look, no title and no contents', () => {
		expect(documentOptions({}, 'en-AU')).toEqual({
			pageSize: 'a4',
			style: 'plain',
			title: undefined,
			toc: false
		});
	});

	it('reads what the model passed, in any case', () => {
		expect(
			documentOptions({ page_size: 'Letter', style: 'REPORT', title: ' Q3 ', toc: true }, 'en-GB')
		).toEqual({ pageSize: 'letter', style: 'report', title: 'Q3', toc: true });
		expect(documentOptions({ toc: 'true' }, 'en-US')).toMatchObject({ toc: true });
	});

	it('names the choices when a value is not one', () => {
		expect(documentOptions({ page_size: 'a5' }, 'en-US')).toEqual({
			error: 'page_size must be a4 or letter.'
		});
		expect(documentOptions({ style: 'fancy' }, 'en-US')).toEqual({
			error: 'style must be one of plain, report, letter.'
		});
	});
});
