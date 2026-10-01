import { describe, it, expect } from 'vitest';
import { deriveSpec, sheetName } from './derive';
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
