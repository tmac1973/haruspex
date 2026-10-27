import { describe, it, expect } from 'vitest';
import { parseJudgement, parseSubmitted } from './tools';

describe('parseJudgement', () => {
	it('reads a verdict and its reason', () => {
		expect(parseJudgement({ ok: false, reason: '  Wrong colour.  ' })).toEqual({
			ok: false,
			reason: 'Wrong colour.'
		});
	});

	it('fills in a missing or blank reason', () => {
		expect(parseJudgement({ ok: true })).toEqual({ ok: true, reason: 'Accepted.' });
		expect(parseJudgement({ ok: false, reason: '   ' })).toEqual({
			ok: false,
			reason: 'Rejected without a reason.'
		});
		expect(parseJudgement({ ok: true, reason: 42 })).toEqual({ ok: true, reason: 'Accepted.' });
	});

	it('is null without a boolean verdict', () => {
		expect(parseJudgement(undefined)).toBeNull();
		expect(parseJudgement({})).toBeNull();
		expect(parseJudgement({ ok: 'true', reason: 'fine' })).toBeNull();
	});
});

describe('parseSubmitted', () => {
	it('reads recipes and edges by trimmed id', () => {
		const got = parseSubmitted({
			recipes: [{ id: ' grass ', recipe: { base: 'noise' }, drawn: ' Green tufts. ' }],
			edges: [{ id: ' grass-dirt ', edge: { kind: 'blend' } }]
		});
		expect(got.recipes).toEqual(
			new Map([['grass', { recipe: { base: 'noise' }, drawn: 'Green tufts.' }]])
		);
		expect(got.edges).toEqual(new Map([['grass-dirt', { kind: 'blend' }]]));
	});

	it('drops malformed entries and keeps the rest', () => {
		const got = parseSubmitted({
			recipes: [
				null,
				'grass',
				{ id: 3, recipe: {} },
				{ id: 'list', recipe: [] },
				{ id: 'none' },
				{ id: 'stone', recipe: { base: 'cells' } }
			],
			edges: [null, { id: 'a' }, { id: 'b', edge: 'blend' }, { edge: {} }, { id: 'c', edge: {} }]
		});
		expect([...got.recipes.keys()]).toEqual(['stone']);
		expect(got.recipes.get('stone')?.drawn).toBe('');
		expect([...got.edges.keys()]).toEqual(['c']);
	});

	it('is empty for missing or non-array fields', () => {
		for (const args of [undefined, {}, { recipes: 'x', edges: { id: 'a' } }]) {
			const got = parseSubmitted(args);
			expect(got.recipes.size).toBe(0);
			expect(got.edges.size).toBe(0);
		}
	});
});
