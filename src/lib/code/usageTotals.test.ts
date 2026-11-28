import { describe, it, expect } from 'vitest';
import {
	addCall,
	addSessionCall,
	callCostUsd,
	catalogPrices,
	emptyUsage,
	formatCost
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
			estimated: false,
			subagentTokens: 0,
			subagentCalls: 0
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

	it('counts a sub-agent’s call in the total and in its own share', () => {
		let t = addCall(emptyUsage(), call(1000, 100), false, null);
		t = addCall(t, call(500, 50), false, null, true);
		expect(t).toMatchObject({
			promptTokens: 1500,
			completionTokens: 150,
			calls: 2,
			subagentTokens: 550,
			subagentCalls: 1
		});
	});

	it('reads catalogue prices, or none for an unknown model', () => {
		const catalog = [{ id: 'a/b', pricing: { prompt: '0.000001', completion: '0.000002' } }];
		expect(catalogPrices(catalog, 'a/b')).toEqual({ prompt: 1e-6, completion: 2e-6 });
		expect(catalogPrices(catalog, 'c/d')).toBeNull();
		expect(catalogPrices(null, 'a/b')).toBeNull();
	});

	it('formats counts and costs compactly', () => {
		expect(formatCost(0)).toBe('$0.00');
		expect(formatCost(0.004)).toBe('<$0.01');
		expect(formatCost(12.3)).toBe('$12.30');
	});
});

describe('callCostUsd', () => {
	it('is the reported cost, else the catalogue estimate, else nothing', () => {
		const prices = { prompt: 0.001, completion: 0.002 };
		expect(callCostUsd(call(100, 10, 0.5), prices)).toBe(0.5);
		expect(callCostUsd(call(100, 10), prices)).toBeCloseTo(0.12);
		expect(callCostUsd(call(100, 10), null)).toBe(0);
	});
});

describe('addSessionCall', () => {
	const prices = { prompt: 0.001, completion: 0.002 };
	const openrouter = { openrouter: true, prices: () => prices };
	const local = { openrouter: false, prices: () => null };

	it('prices the session’s own calls, and a sub-agent on its model, by the session', () => {
		expect(addSessionCall(emptyUsage(), call(100, 10), openrouter).costUsd).toBeCloseTo(0.12);
		const sub = addSessionCall(emptyUsage(), call(100, 10), openrouter, { subagent: true });
		expect(sub.costUsd).toBeCloseTo(0.12);
		expect(sub.subagentCalls).toBe(1);
	});

	it('never prices a sub-agent on its own model by the session’s catalogue entry', () => {
		const own = { subagent: true, ownModel: true };
		const unpriced = addSessionCall(emptyUsage(), call(100, 10), openrouter, own);
		expect(unpriced).toMatchObject({ costUsd: null, estimated: false, subagentTokens: 110 });
		const priced = addSessionCall(emptyUsage(), call(100, 10, 0.5), local, own);
		expect(priced.costUsd).toBe(0.5);
	});
});
