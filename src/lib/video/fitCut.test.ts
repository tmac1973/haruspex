import { describe, it, expect } from 'vitest';
import { planReplacement } from './fitCut';

describe('planReplacement', () => {
	it('fits a take close to the gap, at both edges of the range', () => {
		expect(planReplacement(1.7, 2, 'auto')).toEqual({ mode: 'fit', speed: 2 / 1.7 });
		expect(planReplacement(2.5, 2, 'auto')).toEqual({ mode: 'fit', speed: 0.8 });
		expect(planReplacement(2, 2, 'auto')).toEqual({ mode: 'fit', speed: 1 });
	});

	it('cuts the spare tail of a long gap, and holds a frame for a long take', () => {
		const short = planReplacement(1.6, 2, 'auto');
		expect(short.mode).toBe('cut');
		expect('holdSecs' in short && short.holdSecs).toBeCloseTo(0.4);
		const long = planReplacement(2.6, 2, 'auto');
		expect('trimSecs' in long && long.trimSecs).toBeCloseTo(0.6);
	});

	it('does what a forced mode says', () => {
		expect(planReplacement(4, 2, 'fit')).toEqual({ mode: 'fit', speed: 0.5 });
		expect(planReplacement(2, 2.2, 'cut')).toMatchObject({ mode: 'cut' });
		expect('holdSecs' in planReplacement(2, 2.2, 'cut')).toBe(true);
	});
});
