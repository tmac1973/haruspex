import { describe, expect, it } from 'vitest';
import {
	ancestors,
	compareTree,
	countKinds,
	firstFile,
	isAttempt,
	stepFile,
	treeRows,
	visibleFiles
} from './fileTree';

describe('fileTree', () => {
	const files = ['a/attempts/create-01/a.glb', 'a/a.glb', 'a/sheet.png', 'b/b.glb'];

	it('lists one kind, hiding attempts unless asked, but never the file showing', () => {
		expect(isAttempt('x/attempts/animate-02/x.glb')).toBe(true);
		expect(isAttempt('attempts.glb')).toBe(false);
		expect(visibleFiles(files, 'b/b.glb', 'glb', false)).toEqual(['a/a.glb', 'b/b.glb']);
		expect(visibleFiles(files, files[0], 'glb', false)).toEqual([files[0], 'a/a.glb', 'b/b.glb']);
		expect(visibleFiles(files, 'b/b.glb', 'glb', true)).toEqual([files[0], 'a/a.glb', 'b/b.glb']);
		expect(visibleFiles(files, 'a/a.glb', 'image', false)).toEqual(['a/a.glb', 'a/sheet.png']);
		expect(visibleFiles(['n.md', 'a/x.ts', 'p.png'], 'p.png', 'text', false)).toEqual([
			'a/x.ts',
			'n.md',
			'p.png'
		]);
	});

	it('counts each kind, text included', () => {
		expect([...countKinds([...files, 'notes.txt'], false)]).toEqual([
			['glb', 2],
			['image', 1],
			['text', 1]
		]);
		expect(countKinds(files, true).get('glb')).toBe(3);
	});

	it('opens a folder on its first model, then its first image', () => {
		expect(firstFile(files)).toBe('a/a.glb');
		expect(firstFile(['x/attempts/create-01/x.glb'])).toBe('x/attempts/create-01/x.glb');
		expect(firstFile(['p.png', 'notes.txt'])).toBe('p.png');
		expect(firstFile(['hit.wav', 'p.png'])).toBe('p.png');
		expect(firstFile(['hit.wav'])).toBe('hit.wav');
		expect(firstFile(['notes.txt'])).toBe('notes.txt');
		expect(firstFile([])).toBeNull();
	});

	it('steps both ways and wraps round', () => {
		const list = ['a.glb', 'b.glb', 'c.glb'];
		expect(stepFile(list, 'a.glb', 1)).toBe('b.glb');
		expect(stepFile(list, 'c.glb', 1)).toBe('a.glb');
		expect(stepFile(list, 'a.glb', -1)).toBe('c.glb');
		expect(stepFile(list, 'gone.glb', 1)).toBe('a.glb');
		expect(stepFile(list, 'gone.glb', -1)).toBe('c.glb');
		expect(stepFile(['a.glb'], 'a.glb', 1)).toBeNull();
	});

	it('sorts folders before files, numbers by value', () => {
		const sorted = ['z.txt', 'a/b/c.txt', 'a/z.txt', 'take-10.png', 'take-2.png', 'a/a/x.txt'];
		expect(sorted.sort(compareTree)).toEqual([
			'a/a/x.txt',
			'a/b/c.txt',
			'a/z.txt',
			'take-2.png',
			'take-10.png',
			'z.txt'
		]);
	});

	it('lays out folders once each, hiding what a collapsed one holds', () => {
		expect(ancestors('a/b/c.png')).toEqual(['a/', 'a/b/']);
		expect(ancestors('c.png')).toEqual([]);
		const tree = ['a/b/c.txt', 'a/b/d.txt', 'a/e.txt', 'f.txt'];
		const show = (collapsed: string[]) =>
			treeRows(tree, new Set(collapsed)).map(
				(r) => '  '.repeat(r.depth) + r.name + (r.dir ? '/' : '')
			);
		expect(show([])).toEqual(['a/', '  b/', '    c.txt', '    d.txt', '  e.txt', 'f.txt']);
		expect(show(['a/b/'])).toEqual(['a/', '  b/', '  e.txt', 'f.txt']);
		expect(show(['a/'])).toEqual(['a/', 'f.txt']);
	});
});
