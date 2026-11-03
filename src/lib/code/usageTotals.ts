/**
 * A Code session's running count of tokens and cost: every model call its
 * own agent makes, summed across turns and saved with the thread (see
 * `CodeSessionSnapshot.usage`). Subtasks, specialists and compaction calls
 * are not counted.
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
}

/** Per-token USD prices, as the OpenRouter catalogue gives them. */
export interface TokenPrices {
	prompt: number;
	completion: number;
}

export function emptyUsage(): SessionUsage {
	return { promptTokens: 0, completionTokens: 0, calls: 0, costUsd: null, estimated: false };
}

/**
 * `totals` with one more call. `paid`: the call went to OpenRouter; `prices`
 * is its model's catalogue entry, for a call that reports no cost.
 */
export function addCall(
	totals: SessionUsage,
	usage: Usage,
	paid: boolean,
	prices: TokenPrices | null
): SessionUsage {
	const next: SessionUsage = {
		...totals,
		promptTokens: totals.promptTokens + (usage.prompt_tokens || 0),
		completionTokens: totals.completionTokens + (usage.completion_tokens || 0),
		calls: totals.calls + 1
	};
	if (!paid) return next;
	if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) {
		next.costUsd = (totals.costUsd ?? 0) + usage.cost;
	} else {
		// Unpriced too: the total is short, so it is marked as an estimate.
		const cost = prices
			? (usage.prompt_tokens || 0) * prices.prompt +
				(usage.completion_tokens || 0) * prices.completion
			: 0;
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
		estimated: u.estimated === true
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
