import { describe, expect, it } from 'vitest';
import { parseTransition } from './_assetTransition';

const A = { kind: 'grass' };
const B = { kind: 'sand' };

describe('parseTransition', () => {
	it('asks for a view when it is missing or unknown', () => {
		expect(parseTransition({ recipe: A })).toMatch(/needs "view"/);
		expect(parseTransition({ view: 'front', recipe: A })).toMatch(/needs "view"/);
	});

	it('asks for a recipe object', () => {
		expect(parseTransition({ view: 'side' })).toMatch(/needs "recipe"/);
		expect(parseTransition({ view: 'side', recipe: 'grass' })).toMatch(/needs "recipe"/);
		expect(parseTransition({ view: 'side', recipe: [A] })).toMatch(/needs "recipe"/);
	});

	it('asks a top transition for its second material', () => {
		expect(parseTransition({ view: 'top', recipe: A })).toMatch(/needs "recipe_b"/);
		expect(parseTransition({ view: 'top', recipe: A, cap: B })).toMatch(/needs "recipe_b"/);
	});

	it('reads a top transition with both seeds, trimmed', () => {
		expect(
			parseTransition({
				view: 'top',
				recipe: A,
				recipe_b: B,
				edge: { width: 3 },
				seed_from: '  a.png ',
				seed_from_b: 'b.png'
			})
		).toEqual({
			view: 'top',
			recipe: A,
			other: B,
			edge: { width: 3 },
			seedFrom: 'a.png',
			seedFromB: 'b.png'
		});
	});

	it('reads a side transition with an optional cap, and ignores the second seed', () => {
		expect(parseTransition({ view: 'side', recipe: A, seed_from_b: 'b.png' })).toEqual({
			view: 'side',
			recipe: A,
			other: null,
			edge: {},
			seedFrom: null,
			seedFromB: null
		});
		expect(parseTransition({ view: 'side', recipe: A, cap: B, recipe_b: A })).toMatchObject({
			other: B
		});
	});

	it('treats a blank seed as none', () => {
		expect(
			parseTransition({ view: 'top', recipe: A, recipe_b: B, seed_from: '   ', seed_from_b: 4 })
		).toMatchObject({ seedFrom: null, seedFromB: null });
	});
});
