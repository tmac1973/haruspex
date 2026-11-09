import { describe, it, expect } from 'vitest';
import {
	PINNED_RATE_LIMIT_DELAYS_MS,
	parseRetryAfter,
	pinnedRateLimitDelay,
	rateLimitGiveUpMessage,
	rateLimitWaitMessage
} from './rateLimitWait.ts';

describe('parseRetryAfter', () => {
	it('reads delta-seconds', () => {
		expect(parseRetryAfter('7')).toBe(7_000);
		expect(parseRetryAfter(' 1.5 ')).toBe(1_500);
	});

	it('reads an HTTP date', () => {
		const now = Date.parse('Mon, 09 Nov 2026 13:50:00 GMT');
		expect(parseRetryAfter('Mon, 09 Nov 2026 13:50:20 GMT', now)).toBe(20_000);
		expect(parseRetryAfter('Mon, 09 Nov 2026 13:49:00 GMT', now)).toBe(0);
	});

	it('is undefined when absent or unreadable', () => {
		expect(parseRetryAfter(null)).toBeUndefined();
		expect(parseRetryAfter('')).toBeUndefined();
		expect(parseRetryAfter('soon')).toBeUndefined();
	});
});

describe('pinnedRateLimitDelay', () => {
	it('follows the schedule, then gives up', () => {
		const delays = PINNED_RATE_LIMIT_DELAYS_MS.map((_, i) => pinnedRateLimitDelay(i));
		expect(delays).toEqual(PINNED_RATE_LIMIT_DELAYS_MS);
		expect(pinnedRateLimitDelay(PINNED_RATE_LIMIT_DELAYS_MS.length)).toBeNull();
	});

	it('takes Retry-After instead, up to a minute', () => {
		expect(pinnedRateLimitDelay(0, 2_000)).toBe(2_000);
		expect(pinnedRateLimitDelay(0, 600_000)).toBe(60_000);
		expect(pinnedRateLimitDelay(PINNED_RATE_LIMIT_DELAYS_MS.length, 2_000)).toBeNull();
	});
});

describe('messages', () => {
	it('say who is rate-limited, why the turn waits, and for how long', () => {
		expect(
			rateLimitWaitMessage({ provider: 'Google AI Studio', delayMs: 20_000, wait: 3, waits: 6 })
		).toBe(
			"Google AI Studio is rate-limited, and this conversation's reasoning only works there. " +
				'Trying again in 20 s (3 of 6).'
		);
		expect(rateLimitGiveUpMessage('Google', 125_000)).toBe(
			"Google was still rate-limited after 2 min, and this conversation's reasoning only " +
				'works there. Try again later, or switch to another model.'
		);
	});
});
