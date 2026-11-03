import { describe, it, expect } from 'vitest';
import {
	addCall,
	catalogPrices,
	emptyUsage,
	formatCost,
	formatTokens
} from '#lib/code/usageTotals.ts';

const call = (prompt: number, completion: number, cost?: number) => ({
	prompt_tokens: prompt,
	completion_tokens: completion,
	total_tokens: prompt + completion,
	...(cost !== undefined ? { cost } : {})
});

describe('session usage totals', () => {
	it('adds tokens and calls, with no cost off OpenRouter', () => {
		let t = addCall(emptyUsage(), call(1000, 200), false, null);
		t = addCall(t, call(1500, 100), false, null);
		expect(t).toEqual({
			promptTokens: 2500,
			completionTokens: 300,
			calls: 2,
			costUsd: null,
			estimated: false
		});
	});

	it('adds the cost OpenRouter reports', () => {
		let t = addCall(emptyUsage(), call(1000, 200, 0.01), true, null);
		t = addCall(t, call(1000, 200, 0.02), true, null);
		expect(t.costUsd).toBeCloseTo(0.03);
		expect(t.estimated).toBe(false);
	});

	it('works a cost out from catalogue prices when none is reported, and says so', () => {
		const t = addCall(emptyUsage(), call(1000, 100), true, { prompt: 1e-6, completion: 2e-6 });
		expect(t.costUsd).toBeCloseTo(0.0012);
		expect(t.estimated).toBe(true);
		// Stays an estimate once any part of it is one.
		expect(addCall(t, call(1, 1, 0.5), true, null).estimated).toBe(true);
	});

	it('reads catalogue prices, or none for an unknown model', () => {
		const catalog = [{ id: 'a/b', pricing: { prompt: '0.000001', completion: '0.000002' } }];
		expect(catalogPrices(catalog, 'a/b')).toEqual({ prompt: 1e-6, completion: 2e-6 });
		expect(catalogPrices(catalog, 'c/d')).toBeNull();
		expect(catalogPrices(null, 'a/b')).toBeNull();
	});

	it('formats counts and costs compactly', () => {
		expect(formatTokens(950)).toBe('950');
		expect(formatTokens(1234)).toBe('1.2k');
		expect(formatTokens(48_200)).toBe('48k');
		expect(formatTokens(4_100_000)).toBe('4.1M');
		expect(formatCost(0)).toBe('$0.00');
		expect(formatCost(0.004)).toBe('<$0.01');
		expect(formatCost(12.3)).toBe('$12.30');
	});
});
