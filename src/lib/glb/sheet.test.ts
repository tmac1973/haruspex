import { describe, expect, it } from 'vitest';
import { CELL, framedBounds, sheetLayout } from './sheet';
import type { Bounds } from './report';

const bounds = (min: [number, number, number], max: [number, number, number]): Bounds => ({
	min,
	max,
	size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
});

describe('sheetLayout', () => {
	it('lays six labelled cells in a 3 × 2 grid', () => {
		const l = sheetLayout(bounds([-0.5, 0, -0.5], [0.5, 2, 0.5]));
		expect(l.cells.map((c) => [c.label, c.x, c.y])).toEqual([
			['front', 0, 0],
			['right', CELL, 0],
			['back', 2 * CELL, 0],
			['left', 0, CELL],
			['top', CELL, CELL],
			['three-quarter', 2 * CELL, CELL]
		]);
		expect(l.cells[5].half).toBeNull();
	});

	it('frames each orthographic view around the bounds with a margin', () => {
		const l = sheetLayout(bounds([-1, 0, -0.25], [1, 3, 0.25]));
		const [front, right, , , top] = l.cells;
		// front sees x (2) and y (3): half of 3, plus 10 % each side
		expect(front.half).toBeCloseTo(1.5 * 1.2);
		// right sees z (0.5) and y (3)
		expect(right.half).toBeCloseTo(1.5 * 1.2);
		// top sees x (2) and z (0.5)
		expect(top.half).toBeCloseTo(1 * 1.2);
	});

	it('adds 0.1 m grid lines only under 1 m tall', () => {
		expect(sheetLayout(bounds([0, 0, 0], [0.3, 0.5, 0.3])).grid.minor).toBe(0.1);
		expect(sheetLayout(bounds([0, 0, 0], [1, 2, 1])).grid.minor).toBeNull();
		expect(sheetLayout(bounds([0, 0, 0], [1, 2, 1])).grid.major).toBe(1);
	});

	it('stretches the frame to the floor when the asset floats near it', () => {
		expect(framedBounds(bounds([0, 0.5, 0], [1, 1.5, 1])).min[1]).toBe(0);
		expect(framedBounds(bounds([0, 50, 0], [1, 51, 1])).min[1]).toBe(50);
	});
});
