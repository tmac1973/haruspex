/**
 * Waiting out a rate limit on a pinned OpenRouter provider.
 *
 * A thread whose reasoning a provider signed has to stay on that provider
 * (see `providerPin` in `api.ts`), so a 429 there can't be dodged by routing
 * elsewhere. Instead of the short transient-retry backoff, such a request
 * waits up to about two minutes, honouring `Retry-After`, and tells the UI
 * each time it starts a wait.
 */

/** The waits between tries, in order; one more 429 after the last gives up. */
export const PINNED_RATE_LIMIT_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 30_000, 30_000];

/** The longest `Retry-After` honoured; a longer one waits this long instead. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * A `Retry-After` header in ms: delta-seconds or an HTTP date. Undefined
 * when absent or unreadable.
 */
export function parseRetryAfter(
	header: string | null | undefined,
	now = Date.now()
): number | undefined {
	if (!header) return undefined;
	const value = header.trim();
	if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
	const at = Date.parse(value);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * How long to wait before try `waitIndex + 2` (the first wait is index 0),
 * or null when the waits are used up. `Retry-After`, when given, replaces
 * the schedule's delay, capped at `MAX_RETRY_AFTER_MS`.
 */
export function pinnedRateLimitDelay(waitIndex: number, retryAfterMs?: number): number | null {
	const scheduled = PINNED_RATE_LIMIT_DELAYS_MS[waitIndex];
	if (scheduled === undefined) return null;
	return retryAfterMs === undefined ? scheduled : Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
}

/** A wait that is starting: `wait` of `waits`, for `delayMs`. */
export interface RateLimitWait {
	provider: string;
	delayMs: number;
	wait: number;
	waits: number;
}

let listener: ((wait: RateLimitWait) => void) | null = null;

/** Who hears about waits: the root layout, which shows a toast. */
export function setRateLimitWaitListener(fn: ((wait: RateLimitWait) => void) | null): void {
	listener = fn;
}

export function notifyRateLimitWait(wait: RateLimitWait): void {
	listener?.(wait);
}

/** The toast for a wait. */
export function rateLimitWaitMessage(wait: RateLimitWait): string {
	const seconds = Math.round(wait.delayMs / 1000);
	return (
		`${wait.provider} is rate-limited, and this conversation's reasoning only works there. ` +
		`Trying again in ${seconds} s (${wait.wait} of ${wait.waits}).`
	);
}

/** The turn's error when the provider is still rate-limited after every wait. */
export function rateLimitGiveUpMessage(provider: string, waitedMs: number): string {
	const minutes = Math.max(1, Math.round(waitedMs / 60_000));
	return (
		`${provider} was still rate-limited after ${minutes} min, and this conversation's ` +
		`reasoning only works there. Try again later, or switch to another model.`
	);
}
