import { describe, it, expect, beforeEach } from 'vitest';
import { generationSpend, recordSpend, resetGenerationSpend, _resetForTests } from './spend.svelte';

const KEY = 'haruspex.generation.spend';

beforeEach(() => {
	localStorage.clear();
	_resetForTests();
});

describe('generation spend', () => {
	it('sums pictures and clips, and keeps the count across a restart', () => {
		recordSpend('picture', 2, 0.08);
		recordSpend('clip', 1, 1.6);
		expect(generationSpend()).toMatchObject({ pictures: 2, clips: 1, unpriced: 0 });
		expect(generationSpend().usd).toBeCloseTo(1.68);
		_resetForTests();
		expect(generationSpend()).toMatchObject({ pictures: 2, clips: 1 });
		expect(generationSpend().usd).toBeCloseTo(1.68);
	});

	it('counts a result with no price apart, and ignores nothing made', () => {
		recordSpend('clip', 1, null);
		recordSpend('picture', 0, 5);
		recordSpend('picture', 1, Number.NaN);
		expect(generationSpend()).toMatchObject({ usd: 0, pictures: 1, clips: 1, unpriced: 2 });
	});

	it('starts again from now on reset', () => {
		recordSpend('picture', 1, 0.04);
		const before = Date.now();
		resetGenerationSpend();
		const s = generationSpend();
		expect(s).toMatchObject({ usd: 0, pictures: 0, clips: 0, unpriced: 0 });
		expect(Date.parse(s.since)).toBeGreaterThanOrEqual(before - 1000);
		expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ usd: 0 });
	});

	it('reads a damaged count as an empty one', () => {
		localStorage.setItem(KEY, '{"usd":"lots","pictures":-3,"clips":2}');
		_resetForTests();
		expect(generationSpend()).toMatchObject({ usd: 0, pictures: 0, clips: 2 });
		localStorage.setItem(KEY, 'not json');
		_resetForTests();
		expect(generationSpend().usd).toBe(0);
	});
});
