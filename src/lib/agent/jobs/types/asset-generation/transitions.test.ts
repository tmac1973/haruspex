import { describe, it, expect, vi } from 'vitest';
import type { AssetSpec, TransitionEntry } from '#lib/assets/spec/types.ts';
import { applyTransitions, runTransition, type TransitionDeps } from './transitions';
import { textureSeed } from './recipes';

const R = { base: { ramp: ['#000000', '#ffffff'] }, layers: [] };

function spec(): AssetSpec {
	return {
		version: 1,
		style: { prompt: 'pixel art' },
		anchor: { image: 'a.png', recipe: 'a.json' },
		normalize: {} as AssetSpec['normalize'],
		entries: [
			{ id: 'grass', kind: 'texture', prompt: 'grass', out: 't/grass.png', recipe: R },
			{ id: 'dirt', kind: 'texture', prompt: 'dirt', out: 't/dirt.png', recipe: R },
			{ id: 'mud', kind: 'texture', prompt: 'mud', out: 't/mud.png' }
		]
	} as AssetSpec;
}

const TOP: TransitionEntry = {
	id: 'grass_dirt',
	view: 'top',
	a: 'grass',
	b: 'dirt',
	out: 't/sets/grass_dirt.png',
	edge: { wobble: 0.1 }
};

function harness(over: Partial<TransitionDeps> = {}, present: string[] = []) {
	const written: Record<string, unknown> = {};
	const deps: TransitionDeps = {
		spec: spec(),
		tileSize: 32,
		signal: new AbortController().signal,
		exists: async (rel) => present.includes(rel),
		writeBytes: async (rel, bytes) => void (written[rel] = bytes),
		writeText: async (rel, text) => void (written[rel] = text),
		render: vi.fn(async () => new Uint8Array([1])),
		preview: vi.fn(async (_v, sheet: Uint8Array) => new Uint8Array([9, ...sheet])),
		judge: null,
		revise: vi.fn(async () => null),
		...over
	};
	return { deps, written };
}

describe('runTransition', () => {
	it("draws a top set from both materials' recipes and seeds, and writes the sheet and its map", async () => {
		const h = harness();
		const o = await runTransition(TOP, h.deps);
		expect(o).toMatchObject({ status: 'done', attempts: 1 });
		const [view, a, other, edge, seeds] = vi.mocked(h.deps.render).mock.calls[0];
		expect([view, a, other, edge]).toEqual(['top', R, R, { wobble: 0.1 }]);
		const s = spec();
		expect(seeds).toEqual({ a: textureSeed(s.entries[0]), other: textureSeed(s.entries[1]) });
		expect(Object.keys(h.written)).toEqual(['t/sets/grass_dirt.png', 't/sets/grass_dirt.json']);
		const map = JSON.parse(h.written['t/sets/grass_dirt.json'] as string);
		expect(map).toMatchObject({ view: 'top', a: 'grass', b: 'dirt', tile_size: 32 });
	});

	it('skips a set whose sheet is already there', async () => {
		const h = harness({}, ['t/sets/grass_dirt.png']);
		expect((await runTransition(TOP, h.deps)).status).toBe('skipped');
		expect(h.deps.render).not.toHaveBeenCalled();
	});

	it('fails a set whose material has no recipe, naming it', async () => {
		const h = harness();
		const o = await runTransition({ ...TOP, b: 'mud' }, h.deps);
		expect(o).toMatchObject({
			status: 'failed',
			reason: "The set needs mud's recipe, and it has none."
		});
	});

	it('revises the edge once on a no, and keeps the revision', async () => {
		let n = 0;
		const judge = vi.fn(async () => ({ ok: n++ > 0, reason: 'a ruler line' }));
		const revise = vi.fn<TransitionDeps['revise']>(async () => ({ wobble: 0.22 }));
		const h = harness({ judge, revise });
		const o = await runTransition(TOP, h.deps);
		expect(o).toMatchObject({ status: 'done', attempts: 2, edge: { wobble: 0.22 } });
		expect(vi.mocked(h.deps.render).mock.calls[1][3]).toEqual({ wobble: 0.22 });
		// The reviser saw what the judge saw: the set laid out as a map.
		expect(revise.mock.calls[0][2]).toEqual(new Uint8Array([9, 1]));
	});

	it('keeps the sheet and says why after a second no', async () => {
		const judge = vi.fn(async () => ({ ok: false, reason: 'a ruler line' }));
		const h = harness({ judge, revise: vi.fn(async () => ({ wobble: 0.2 })) });
		const o = await runTransition(TOP, h.deps);
		expect(o).toMatchObject({ status: 'unresolved', reason: 'a ruler line', attempts: 2 });
		expect(judge).toHaveBeenCalledTimes(2);
		expect(h.written['t/sets/grass_dirt.png']).toBeDefined();
	});

	it('builds no preview when no judge will look', async () => {
		const h = harness();
		await runTransition(TOP, h.deps);
		expect(h.deps.preview).not.toHaveBeenCalled();
	});

	it('draws a side set from the ground and its cap, or the ground alone', async () => {
		const side: TransitionEntry = {
			id: 'ledge',
			view: 'side',
			a: 'dirt',
			cap: 'grass',
			out: 't/l.png'
		};
		const h = harness();
		await runTransition(side, h.deps);
		expect(vi.mocked(h.deps.render).mock.calls[0].slice(0, 4)).toEqual(['side', R, R, {}]);
		await runTransition({ ...side, cap: undefined }, h.deps);
		expect(vi.mocked(h.deps.render).mock.calls[1][2]).toBeNull();
		expect(JSON.parse(h.written['t/l.json'] as string)).not.toHaveProperty('cap');
	});
});

describe('applyTransitions', () => {
	const withSet = (t: Partial<TransitionEntry> = {}) => ({
		...spec(),
		transitions: [{ ...TOP, ...t }]
	});

	it('keeps a revised edge and marks a set the judge never passed', () => {
		const s = applyTransitions(withSet(), [
			{
				id: 'grass_dirt',
				status: 'unresolved',
				attempts: 2,
				durationMs: 1,
				reason: 'seams',
				edge: { wobble: 0.2 }
			}
		]);
		expect(s?.transitions?.[0]).toMatchObject({ edge: { wobble: 0.2 }, rejected: 'seams' });
	});

	it('unmarks a set that passed this time, and changes nothing otherwise', () => {
		const s = applyTransitions(withSet({ rejected: 'seams' }), [
			{ id: 'grass_dirt', status: 'done', attempts: 1, durationMs: 1 }
		]);
		expect(s?.transitions?.[0]).not.toHaveProperty('rejected');
		expect(
			applyTransitions(withSet(), [
				{ id: 'grass_dirt', status: 'done', attempts: 1, durationMs: 1 }
			])
		).toBeNull();
	});
});
