import { describe, expect, it } from 'vitest';
import { isAttempt, splitPath, stepModel, visibleModels } from './glbList';

describe('glbList', () => {
	const files = ['a/attempts/create-01/a.glb', 'a/a.glb', 'b/b.glb'];

	it('hides attempts unless asked, but never the model showing', () => {
		expect(isAttempt('x/attempts/animate-02/x.glb')).toBe(true);
		expect(isAttempt('attempts.glb')).toBe(false);
		expect(visibleModels(files, 'b/b.glb', false)).toEqual(['a/a.glb', 'b/b.glb']);
		expect(visibleModels(files, files[0], false)).toEqual(files);
		expect(visibleModels(files, 'b/b.glb', true)).toEqual(files);
	});

	it('steps both ways and wraps round', () => {
		const list = ['a.glb', 'b.glb', 'c.glb'];
		expect(stepModel(list, 'a.glb', 1)).toBe('b.glb');
		expect(stepModel(list, 'c.glb', 1)).toBe('a.glb');
		expect(stepModel(list, 'a.glb', -1)).toBe('c.glb');
		expect(stepModel(list, 'gone.glb', 1)).toBe('a.glb');
		expect(stepModel(list, 'gone.glb', -1)).toBe('c.glb');
		expect(stepModel(['a.glb'], 'a.glb', 1)).toBeNull();
	});

	it('splits a path into folder and name', () => {
		expect(splitPath('m/knight/knight.glb')).toEqual({ dir: 'm/knight/', name: 'knight.glb' });
		expect(splitPath('knight.glb')).toEqual({ dir: '', name: 'knight.glb' });
	});
});
