import { describe, it, expect } from 'vitest';
import { transitionMap, variantPaths } from './texture';

describe('transitionMap', () => {
	it('lists 16 tiles in index order, placed 4 across', () => {
		const m = transitionMap('top', 32, 'grass', 'dirt');
		expect(m.tiles.map((t) => t.index)).toEqual([...Array(16).keys()]);
		expect(m.tiles[5]).toMatchObject({ x: 32, y: 32 });
		expect(m.tiles[15]).toMatchObject({ x: 96, y: 96 });
		expect(m).toMatchObject({ view: 'top', tile_size: 32, columns: 4, a: 'grass', b: 'dirt' });
	});

	it('names each corner by its bit: NW 1, NE 2, SW 4, SE 8', () => {
		const m = transitionMap('top', 16, 'grass', 'dirt');
		expect(m.tiles[0].corners).toEqual({ nw: 'dirt', ne: 'dirt', sw: 'dirt', se: 'dirt' });
		expect(m.tiles[6].corners).toEqual({ nw: 'dirt', ne: 'grass', sw: 'grass', se: 'dirt' });
		expect(m.tiles[15].corners).toEqual({ nw: 'grass', ne: 'grass', sw: 'grass', se: 'grass' });
	});

	it('calls a side set’s empty corners air, and names its cap only when it has one', () => {
		const capped = transitionMap('side', 16, 'soil', 'turf');
		expect(capped.tiles[12].corners).toEqual({ nw: 'air', ne: 'air', sw: 'soil', se: 'soil' });
		expect(capped.cap).toBe('turf');
		expect(capped).not.toHaveProperty('b');
		expect(transitionMap('side', 16, 'stone')).not.toHaveProperty('cap');
	});
});

describe('variantPaths', () => {
	it('puts the base first and numbers the rest beside it', () => {
		expect(variantPaths('tiles/grass.png', 3)).toEqual([
			'tiles/grass.png',
			'tiles/grass_1.png',
			'tiles/grass_2.png'
		]);
	});
});
