import { describe, it, expect } from 'vitest';
import { makeCodePathLinker, parsePathRef, relativeToRoot, splitGrepLine } from './paths';

describe('relativeToRoot', () => {
	it.each([
		['src/app.ts', 'src/app.ts'],
		['./src/app.ts', 'src/app.ts'],
		['/proj/src/app.ts', 'src/app.ts'],
		['/proj/src/../README.md', 'README.md'],
		['/proj/', null],
		['/proj', null],
		['../other/x.ts', null],
		['src/../../etc/passwd', null],
		['/etc/passwd', null],
		['/project/x.ts', null],
		['~/x.ts', null],
		['', null]
	])('%s → %s', (path, want) => {
		expect(relativeToRoot('/proj', path)).toBe(want);
	});

	it('takes a root with a trailing slash', () => {
		expect(relativeToRoot('/proj/', '/proj/a.ts')).toBe('a.ts');
	});
});

describe('parsePathRef', () => {
	it.each([
		['src/app.ts', { path: 'src/app.ts', line: null }],
		['src/app.ts:42', { path: 'src/app.ts', line: 42 }],
		['src/app.ts:42:7', { path: 'src/app.ts', line: 42 }],
		['app.ts:42', { path: 'app.ts', line: 42 }],
		['src/Makefile:3', { path: 'src/Makefile', line: 3 }],
		['/proj/a.rs', { path: '/proj/a.rs', line: null }],
		['./lib/.env', { path: './lib/.env', line: null }]
	])('%s is a reference', (text, want) => {
		expect(parsePathRef(text)).toEqual(want);
	});

	it.each([
		'Node.js',
		'app.ts',
		'and/or',
		'12:30',
		'src/lib',
		'localhost:8080',
		'a b/c.ts',
		'https://example.com/a.ts',
		'src/app.ts:0',
		'1.2/3.4'
	])('%s is not', (text) => {
		expect(parsePathRef(text)).toBeNull();
	});
});

describe('makeCodePathLinker', () => {
	const link = makeCodePathLinker('/proj');

	it('links references inside the folder, made relative', () => {
		expect(link('/proj/src/a.ts:3')).toEqual({ path: 'src/a.ts', line: 3 });
		expect(link('src/a.ts')).toEqual({ path: 'src/a.ts', line: null });
	});

	it('leaves references outside it alone', () => {
		expect(link('/etc/hosts.conf')).toBeNull();
		expect(link('../x/a.ts')).toBeNull();
	});
});

describe('splitGrepLine', () => {
	it.each([
		['src/a.ts:12: const x = 1;', { path: 'src/a.ts', line: 12, rest: ':12: const x = 1;' }],
		['src/a.ts-13: context', { path: 'src/a.ts', line: 13, rest: '-13: context' }],
		['src/a.ts: 3', { path: 'src/a.ts', line: null, rest: ': 3' }],
		['src/a.ts', { path: 'src/a.ts', line: null, rest: '' }]
	])('%s', (text, want) => {
		expect(splitGrepLine(text)).toEqual(want);
	});

	it.each(['Total: 4 in 2 files', '… (truncated — narrow the pattern)', 'No matches.'])(
		'skips %s',
		(text) => {
			expect(splitGrepLine(text)).toBeNull();
		}
	);
});
