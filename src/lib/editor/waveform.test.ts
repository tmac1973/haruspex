import { describe, expect, it } from 'vitest';
import { clock, peaks } from './waveform';

describe('peaks', () => {
	it('takes the loudest sample of each slice, across channels', () => {
		const left = new Float32Array([0.1, -0.5, 0.2, 0.0]);
		const right = new Float32Array([0.0, 0.1, 0.0, -0.9]);
		expect(peaks([left, right], 2).map((v) => v.toFixed(1))).toEqual(['0.5', '0.9']);
		expect(peaks([left], 4).map((v) => v.toFixed(1))).toEqual(['0.1', '0.5', '0.2', '0.0']);
	});

	it('copes with more slices than samples, and with silence', () => {
		expect(peaks([new Float32Array([1, -1])], 4)).toHaveLength(4);
		expect(peaks([], 10)).toEqual([]);
	});

	it('writes m:ss', () => {
		expect(clock(0)).toBe('0:00');
		expect(clock(151.7)).toBe('2:31');
	});
});
