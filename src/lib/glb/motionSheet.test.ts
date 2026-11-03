import { describe, expect, it } from 'vitest';
import { FRAMES, motionSheetLayout } from './motionSheet';
import { SHEET_HEIGHT, SHEET_WIDTH } from './sheet';

describe('motionSheetLayout', () => {
	const tall = motionSheetLayout({ min: [-0.3, 0, -0.2], max: [0.3, 2, 0.2] }, 0);

	it('lays two strips of frames and two overlays over the whole sheet', () => {
		expect(tall.cells).toHaveLength(2 * FRAMES + 2);
		const area = tall.cells.reduce((n, c) => n + c.w * c.h, 0);
		expect(area).toBe(SHEET_WIDTH * SHEET_HEIGHT);
		expect(tall.cells.slice(0, FRAMES).every((c) => c.view === 'right' && c.y === 0)).toBe(true);
		expect(tall.cells.slice(FRAMES, 2 * FRAMES).every((c) => c.view === 'front')).toBe(true);
		expect(tall.cells.slice(2 * FRAMES).map((c) => [c.view, c.frame, c.w, c.h])).toEqual([
			['right', null, 600, 400],
			['front', null, 600, 400]
		]);
		for (let i = 1; i < tall.cells.length; i++) {
			const [a, b] = [tall.cells[i - 1], tall.cells[i]];
			const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
			expect(apart).toBe(true);
		}
	});

	it('fits a tall model by its height, keeping each cell’s shape', () => {
		const strip = tall.cells[0];
		expect(strip.halfH * 2).toBeCloseTo(2 * 1.1);
		expect(strip.halfW / strip.halfH).toBeCloseTo(strip.w / strip.h);
	});

	it('fits a wide model by its width', () => {
		const wide = motionSheetLayout({ min: [-2, 0, -0.1], max: [2, 0.5, 0.1] }, 0);
		const front = wide.cells[FRAMES];
		expect(front.halfW * 2).toBeGreaterThanOrEqual(4);
	});

	it('reaches down to a floor below the model', () => {
		const floating = motionSheetLayout({ min: [-0.5, 1, -0.5], max: [0.5, 2, 0.5] }, 0);
		expect(floating.centre[1]).toBeCloseTo(1);
		expect(floating.cells[0].halfH * 2).toBeCloseTo(2 * 1.1);
	});
});
