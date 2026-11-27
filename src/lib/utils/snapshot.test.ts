import { describe, it, expect } from 'vitest';
import { snapshot } from './snapshot.ts';

describe('snapshot', () => {
	it('is a deep copy', () => {
		const v = { a: [1, { b: 'c' }] };
		const copy = snapshot(v);
		expect(copy).toEqual(v);
		expect(copy.a).not.toBe(v.a);
	});

	it('turns undefined into null rather than throwing', () => {
		expect(snapshot(undefined)).toBeNull();
	});
});
