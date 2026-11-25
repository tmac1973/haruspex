import { describe, expect, it } from 'vitest';
import { edgeSpeed } from './dragAutoScroll';

describe('edgeSpeed', () => {
	it('is zero in the middle', () => {
		expect(edgeSpeed(500, 0, 1000)).toBe(0);
	});

	it('scrolls up near the top and down near the bottom', () => {
		expect(edgeSpeed(10, 0, 1000)).toBeLessThan(0);
		expect(edgeSpeed(990, 0, 1000)).toBeGreaterThan(0);
	});

	it('goes faster closer to the edge and caps past it', () => {
		expect(edgeSpeed(980, 0, 1000)).toBeGreaterThan(edgeSpeed(960, 0, 1000));
		expect(edgeSpeed(1200, 0, 1000)).toBe(edgeSpeed(1000, 0, 1000));
		expect(edgeSpeed(-50, 0, 1000)).toBe(-edgeSpeed(1000, 0, 1000));
	});

	it('keeps a small scroller mostly free of edge zones', () => {
		expect(edgeSpeed(50, 0, 100)).toBe(0);
		expect(edgeSpeed(0, 0, 0)).toBe(0);
	});
});
