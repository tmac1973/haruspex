import { describe, expect, it } from 'vitest';
import { countKinds, firstFile, isAttempt, splitPath, stepFile, visibleFiles } from './viewerList';

describe('viewerList', () => {
	const files = ['a/attempts/create-01/a.glb', 'a/a.glb', 'a/sheet.png', 'b/b.glb'];

	it('lists one kind, hiding attempts unless asked, but never the file showing', () => {
		expect(isAttempt('x/attempts/animate-02/x.glb')).toBe(true);
		expect(isAttempt('attempts.glb')).toBe(false);
		expect(visibleFiles(files, 'b/b.glb', 'glb', false)).toEqual(['a/a.glb', 'b/b.glb']);
		expect(visibleFiles(files, files[0], 'glb', false)).toEqual([files[0], 'a/a.glb', 'b/b.glb']);
		expect(visibleFiles(files, 'b/b.glb', 'glb', true)).toEqual([files[0], 'a/a.glb', 'b/b.glb']);
		expect(visibleFiles(files, 'a/a.glb', 'image', false)).toEqual(['a/a.glb', 'a/sheet.png']);
	});

	it('counts each kind', () => {
		expect([...countKinds(files, false)]).toEqual([
			['glb', 2],
			['image', 1]
		]);
		expect(countKinds(files, true).get('glb')).toBe(3);
	});

	it('opens a folder on its first model, then its first image', () => {
		expect(firstFile(files)).toBe('a/a.glb');
		expect(firstFile(['x/attempts/create-01/x.glb'])).toBe('x/attempts/create-01/x.glb');
		expect(firstFile(['p.png', 'notes.txt'])).toBe('p.png');
		expect(firstFile(['hit.wav', 'p.png'])).toBe('p.png');
		expect(firstFile(['hit.wav'])).toBe('hit.wav');
		expect(firstFile(['notes.txt'])).toBeNull();
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

	it('splits a path into folder and name', () => {
		expect(splitPath('m/knight/knight.glb')).toEqual({ dir: 'm/knight/', name: 'knight.glb' });
		expect(splitPath('knight.glb')).toEqual({ dir: '', name: 'knight.glb' });
	});
});
