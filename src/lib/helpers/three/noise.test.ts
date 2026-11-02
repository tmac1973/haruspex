import { describe, expect, it } from 'vitest';
import { createNoise, random } from './noise';

describe('random', () => {
	it('repeats for a seed and differs between seeds', () => {
		const a = random(7);
		const b = random(7);
		const c = random(8);
		const first = [a(), a(), a()];
		expect([b(), b(), b()]).toEqual(first);
		expect([c(), c(), c()]).not.toEqual(first);
		expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
	});
});

describe('createNoise', () => {
	it('repeats for a seed, stays in [-1, 1] and varies smoothly', () => {
		const n = createNoise(42);
		const m = createNoise(42);
		const other = createNoise(43);
		const samples: number[] = [];
		for (let i = 0; i < 400; i++) {
			const x = i * 0.173;
			const y = i * 0.091;
			const v2 = n.noise2(x, y);
			const v3 = n.noise3(x, y, i * 0.05);
			expect(m.noise2(x, y)).toBe(v2);
			expect(m.noise3(x, y, i * 0.05)).toBe(v3);
			samples.push(v2, v3);
		}
		expect(samples.every((v) => v >= -1 && v <= 1)).toBe(true);
		expect(new Set(samples.map((v) => v.toFixed(3))).size).toBeGreaterThan(100);
		expect(other.noise2(1.3, 2.7)).not.toBe(n.noise2(1.3, 2.7));
		// Smooth: a tiny step changes the value a little.
		expect(Math.abs(n.noise2(1.3, 2.7) - n.noise2(1.3001, 2.7))).toBeLessThan(0.01);
	});
});
