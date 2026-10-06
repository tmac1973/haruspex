import { describe, it, expect, vi } from 'vitest';
import type { AssetSpec } from '$lib/assets/spec/types';
import {
	applyCodeTextures,
	needingRecipes,
	reviseRecipe,
	textureSeed,
	variantPaths,
	writeRecipes,
	type RecipeDeps
} from './recipes';

const R = { base: { ramp: ['#000000', '#ffffff'] }, layers: [] };

function spec(): AssetSpec {
	return {
		version: 1,
		style: { prompt: 'pixel art' },
		anchor: { image: 'a.png', recipe: 'a.json' },
		normalize: { palette: [0x2a2a2dff] } as AssetSpec['normalize'],
		entries: [
			{ id: 'street', kind: 'texture', prompt: 'cracked asphalt', out: 't/street.png' },
			{ id: 'grass', kind: 'texture', prompt: 'short grass', out: 't/grass.png' },
			{ id: 'rat', kind: 'sprite', prompt: 'a rat', out: 's/rat.png' }
		]
	};
}

function deps(answers: Array<Record<string, unknown>>, bad: Set<unknown> = new Set()): RecipeDeps {
	return {
		ask: vi.fn(
			async () =>
				new Map(Object.entries(answers.shift() ?? {})) as Map<string, Record<string, unknown>>
		),
		validate: vi.fn(async (r: unknown) => (bad.has(r) ? 'base.ramp: too few' : null))
	};
}

describe('writeRecipes', () => {
	it('asks once for every texture without a recipe, and leaves sprites alone', async () => {
		const d = deps([{ street: R, grass: R }]);
		const r = await writeRecipes(spec(), d);
		expect(r.written.sort()).toEqual(['grass', 'street']);
		expect(r.failed.size).toBe(0);
		expect(r.spec.entries.find((e) => e.id === 'rat')).not.toHaveProperty('recipe');
		expect(d.ask).toHaveBeenCalledTimes(1);
		const prompt = vi.mocked(d.ask).mock.calls[0][0];
		expect(prompt).toContain('#2a2a2d');
		expect(prompt).toContain('street: cracked asphalt');
		expect(prompt).not.toContain('rat');
	});

	it('asks again once for a refused recipe, quoting the refusal', async () => {
		const badR = { base: { ramp: ['#000000'] } };
		const d = deps([{ street: badR, grass: R }, { street: R }], new Set([badR]));
		const r = await writeRecipes(spec(), d);
		expect(r.failed.size).toBe(0);
		const retry = vi.mocked(d.ask).mock.calls[1][0];
		expect(retry).toContain('base.ramp: too few');
		expect(retry).not.toContain('grass: short grass');
	});

	it('gives up after the retry, with the reason', async () => {
		const d = deps([{ grass: R }, {}]);
		const r = await writeRecipes(spec(), d);
		expect(r.failed.get('street')).toMatch(/No recipe/);
		expect(r.spec.entries.find((e) => e.id === 'street')).not.toHaveProperty('recipe');
	});

	it('does nothing when every texture has a recipe', async () => {
		const s = spec();
		s.entries = s.entries.map((e) => (e.kind === 'texture' ? { ...e, recipe: R } : e));
		expect(needingRecipes(s)).toEqual([]);
		const d = deps([]);
		await writeRecipes(s, d);
		expect(d.ask).not.toHaveBeenCalled();
	});
});

describe('reviseRecipe', () => {
	it('gives the reviewer the judge and the old recipe', async () => {
		const d = deps([{ street: R }]);
		const s = spec();
		const got = await reviseRecipe(s, { ...s.entries[0], recipe: R }, 'looks like carpet', d);
		expect(got).toBe(R);
		const prompt = vi.mocked(d.ask).mock.calls[0][0];
		expect(prompt).toContain('looks like carpet');
		expect(prompt).toContain('"ramp":["#000000","#ffffff"]');
	});
});

describe('helpers', () => {
	it('names variants beside the base', () => {
		expect(variantPaths('t/street.png', 3)).toEqual([
			't/street.png',
			't/street_1.png',
			't/street_2.png'
		]);
		expect(variantPaths('street', 2)).toEqual(['street', 'street_1']);
		expect(variantPaths('t/street.png', 1)).toEqual(['t/street.png']);
	});

	it('seeds from a pinned seed, else from the id, stably', () => {
		const e = spec().entries[0];
		expect(textureSeed({ ...e, seed: 7 })).toBe(7);
		expect(textureSeed(e)).toBe(textureSeed({ ...e }));
		expect(textureSeed(e)).not.toBe(textureSeed(spec().entries[1]));
	});

	it('records the tiles and any revised recipe in the spec', () => {
		const revised = { base: { ramp: ['#111111', '#eeeeee'] }, layers: [] };
		const next = applyCodeTextures(spec(), [
			{
				id: 'street',
				codeDrawn: true,
				variants: ['t/street.png', 't/street_1.png'],
				recipe: revised
			},
			{ id: 'rat' }
		]);
		expect(next?.entries[0]).toMatchObject({
			variants: ['t/street.png', 't/street_1.png'],
			recipe: revised
		});
		expect(next?.entries[2]).not.toHaveProperty('variants');
		expect(applyCodeTextures(spec(), [{ id: 'rat' }])).toBeNull();
	});
});
