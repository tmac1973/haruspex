import { describe, it, expect } from 'vitest';
import {
	FALLBACK_STYLE,
	derivePlanSpec,
	deriveSpec,
	sheetName,
	type PlanDerivePayload
} from './derive';
import { coerceCallArguments } from '$lib/agent/tools';
import { SUBMIT_PLAN_ASSET_SPEC_TOOL } from './tools';
import type { NormalizeProfile } from '$lib/ipc/gen/NormalizeProfile';

describe('sheetName', () => {
	it('slugifies a group name rather than failing the derivation over it', () => {
		expect(sheetName('Small Items', 'sprite')).toBe('small_items');
		expect(sheetName('  characters ', 'icon')).toBe('characters');
	});

	it('drops a name on a texture, which fills its own frame', () => {
		expect(sheetName('ground', 'texture')).toBeUndefined();
	});

	it('drops what cannot become a valid name', () => {
		expect(sheetName('!!!', 'sprite')).toBeUndefined();
		expect(sheetName(42, 'sprite')).toBeUndefined();
		expect(sheetName(undefined, 'sprite')).toBeUndefined();
	});
});

describe('deriveSpec', () => {
	it('carries the sheet the model grouped an entry on', () => {
		const spec = deriveSpec(
			{
				style: { prompt: 'pixel art' },
				entries: [
					{ title: 'Iron sword', kind: 'sprite', prompt: 'an iron sword', sheet: 'Items' },
					{ title: 'Grass', kind: 'texture', prompt: 'grass', sheet: 'Items' },
					{ title: 'Coin', kind: 'icon', prompt: 'a coin' }
				]
			},
			{} as NormalizeProfile
		);
		expect(spec.entries.map((e) => [e.id, e.sheet])).toEqual([
			['iron_sword', 'items'],
			['grass', undefined],
			['coin', undefined]
		]);
	});
});

describe('the anchor sheet', () => {
	const entries = [
		{ title: 'Iron sword', kind: 'sprite', prompt: 'an iron sword', sheet: 'Items' },
		{ title: 'Ghoul', kind: 'sprite', prompt: 'a ghoul', sheet: 'characters' }
	];

	it('is carried when it names a sheet the entries use', () => {
		const spec = deriveSpec(
			{ style: { prompt: 'x' }, anchorSheet: 'Items', entries },
			{} as NormalizeProfile
		);
		expect(spec.anchor.sheet).toBe('items');
	});

	it('is dropped when it names no sheet that exists', () => {
		const spec = deriveSpec(
			{ style: { prompt: 'x' }, anchorSheet: 'vehicles', entries },
			{} as NormalizeProfile
		);
		expect(spec.anchor.sheet).toBeUndefined();
	});
});

describe('derivePlanSpec', () => {
	const profile = { target_size: 64, palette_size: 32 } as unknown as NormalizeProfile;
	const entry = (id: string, over: Record<string, unknown> = {}) => ({
		id,
		kind: 'sprite',
		prompt: `a ${id}`,
		...over
	});

	it('reads entries a model sent as a JSON string, once the tool coerces them', () => {
		// The failure that skipped a night's art: `entries` arrived as a string,
		// was walked character by character, and every "entry" had no id.
		const raw = {
			style: '{"prompt":"pixel art"}',
			entries: JSON.stringify([entry('coin'), entry('grass', { kind: 'texture' })])
		};
		const { spec, rejected } = derivePlanSpec(
			coerceCallArguments(SUBMIT_PLAN_ASSET_SPEC_TOOL, raw) as PlanDerivePayload,
			profile
		);
		expect(rejected).toEqual([]);
		expect(spec.entries.map((e) => e.id)).toEqual(['coin', 'grass']);
		expect(spec.style.prompt).toBe('pixel art');
	});

	it('takes nothing from entries that are not a list, rather than one entry per character', () => {
		const { spec, rejected } = derivePlanSpec(
			{ entries: '[{"id":"coin"}]' as unknown as PlanDerivePayload['entries'] },
			profile
		);
		expect(spec.entries).toEqual([]);
		expect(rejected).toEqual([]);
	});

	it('keeps sheets and the anchor sheet, and draws at the plan size', () => {
		const { spec } = derivePlanSpec(
			{
				targetSize: 32,
				anchorSheet: 'Items',
				entries: [
					entry('coin', { sheet: 'Items' }),
					entry('potion', { sheet: 'items' }),
					entry('grass', { kind: 'texture', sheet: 'items' })
				]
			},
			profile
		);
		expect(spec.entries.map((e) => e.sheet)).toEqual(['items', 'items', undefined]);
		expect(spec.anchor.sheet).toBe('items');
		expect(spec.normalize.target_size).toBe(32);
	});

	it('ignores a size that is not a sprite edge', () => {
		for (const targetSize of [0, 3, 1024, 32.5]) {
			expect(derivePlanSpec({ targetSize, entries: [] }, profile).spec.normalize.target_size).toBe(
				64
			);
		}
	});
});

describe('the style line', () => {
	const profile = { target_size: 64, palette_size: 32 } as unknown as NormalizeProfile;
	const entries = [{ id: 'coin', kind: 'sprite', prompt: 'a coin' }];

	it('accepts a plain string where the schema asks for { prompt }', () => {
		// The third chain sent it that way; coercion cannot make an object out
		// of prose, the style came through empty, and the spec failed.
		const r = derivePlanSpec(
			{
				style: 'chunky pixel art, dark outlines' as unknown as PlanDerivePayload['style'],
				entries
			},
			profile
		);
		expect(r.spec.style.prompt).toBe('chunky pixel art, dark outlines');
		expect(r.styleFallback).toBe(false);
	});

	it('falls back to a neutral line rather than losing the art', () => {
		for (const style of [undefined, { prompt: '  ' }, 42]) {
			const r = derivePlanSpec(
				{ style: style as unknown as PlanDerivePayload['style'], entries },
				profile
			);
			expect(r.spec.style.prompt).toBe(FALLBACK_STYLE);
			expect(r.styleFallback).toBe(true);
			expect(r.spec.entries).toHaveLength(1);
		}
	});

	it('does the same for a standalone derivation', () => {
		const spec = deriveSpec(
			{
				style: 'flat pixel art' as unknown as { prompt?: string },
				entries: [{ title: 'Coin', kind: 'sprite', prompt: 'a coin' }]
			},
			profile
		);
		expect(spec.style.prompt).toBe('flat pixel art');
	});
});
