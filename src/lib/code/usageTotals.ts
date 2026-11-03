/**
 * A Code session's running count of tokens and cost: every model call its
 * agent and its sub-agents (`delegate`, in a turn or in the background) make,
 * summed across turns and saved with the thread (see
 * `CodeSessionSnapshot.usage`). Specialists and compaction calls are not
 * counted.
 *
 * Cost is known only for OpenRouter: the price it reports with each call,
 * or, when a call carries none, one worked out from the model's catalogue
 * prices (`estimated`). Local and self-hosted servers cost nothing here.
 */
import type { Usage } from '#lib/api.ts';

export interface SessionUsage {
	promptTokens: number;
	completionTokens: number;
	/** Model calls counted. */
	calls: number;
	/** USD; null until a call with a known price. */
	costUsd: number | null;
	/** Some of `costUsd` was worked out from catalogue prices, not reported. */
	estimated: boolean;
	/** The part of the token count, and of `calls`, that sub-agents made. */
	subagentTokens: number;
	subagentCalls: number;
}

/** Per-token USD prices, as the OpenRouter catalogue gives them. */
export interface TokenPrices {
	prompt: number;
	completion: number;
}

export function emptyUsage(): SessionUsage {
	return {
		promptTokens: 0,
		completionTokens: 0,
		calls: 0,
		costUsd: null,
		estimated: false,
		subagentTokens: 0,
		subagentCalls: 0
	};
}

/**
 * `totals` with one more call. `paid`: the call went to OpenRouter; `prices`
 * is its model's catalogue entry, for a call that reports no cost.
 * `subagent`: a sub-agent made it.
 */
export function addCall(
	totals: SessionUsage,
	usage: Usage,
	paid: boolean,
	prices: TokenPrices | null,
	subagent = false
): SessionUsage {
	const prompt = usage.prompt_tokens || 0;
	const completion = usage.completion_tokens || 0;
	const next: SessionUsage = {
		...totals,
		promptTokens: totals.promptTokens + prompt,
		completionTokens: totals.completionTokens + completion,
		calls: totals.calls + 1
	};
	if (subagent) {
		next.subagentTokens = totals.subagentTokens + prompt + completion;
		next.subagentCalls = totals.subagentCalls + 1;
	}
	if (!paid) return next;
	if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) {
		next.costUsd = (totals.costUsd ?? 0) + usage.cost;
	} else {
		// Unpriced too: the total is short, so it is marked as an estimate.
		const cost = prices ? prompt * prices.prompt + completion * prices.completion : 0;
		next.costUsd = (totals.costUsd ?? 0) + cost;
		next.estimated = true;
	}
	return next;
}

/** A saved count, or null when there is none or it doesn't parse. */
export function decodeUsage(value: unknown): SessionUsage | null {
	if (!value || typeof value !== 'object') return null;
	const u = value as Partial<SessionUsage>;
	const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
	const prompt = count(u.promptTokens);
	const completion = count(u.completionTokens);
	const calls = count(u.calls);
	if (prompt === null || completion === null || calls === null) return null;
	return {
		promptTokens: prompt,
		completionTokens: completion,
		calls,
		costUsd: count(u.costUsd),
		estimated: u.estimated === true,
		// Absent in a count saved before sub-agents were counted.
		subagentTokens: count(u.subagentTokens) ?? 0,
		subagentCalls: count(u.subagentCalls) ?? 0
	};
}

/** `12.3k`, `4.1M`: a token count for the header. */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/** `$0.04`, `$12.30`; under a cent shows as `<$0.01`. */
export function formatCost(usd: number): string {
	if (usd > 0 && usd < 0.01) return '<$0.01';
	return `$${usd.toFixed(2)}`;
}

/**
 * The prices for `modelId` in the OpenRouter catalogue, or null when it is
 * not there or its prices don't parse.
 */
export function catalogPrices(
	catalog: { id: string; pricing: { prompt: string; completion: string } }[] | null,
	modelId: string
): TokenPrices | null {
	const entry = catalog?.find((m) => m.id === modelId);
	if (!entry) return null;
	const prompt = Number(entry.pricing.prompt);
	const completion = Number(entry.pricing.completion);
	if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
	return { prompt, completion };
}
