import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleep } from './async';

describe('sleep', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('resolves after the delay', async () => {
		let done = false;
		void sleep(1000).then(() => (done = true));
		await vi.advanceTimersByTimeAsync(999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
	});

	it('resolves early when the signal aborts, leaving no timer behind', async () => {
		const ctl = new AbortController();
		let done = false;
		void sleep(60_000, ctl.signal).then(() => (done = true));
		ctl.abort();
		await vi.advanceTimersByTimeAsync(0);
		expect(done).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('resolves at once for a signal that already aborted', async () => {
		const ctl = new AbortController();
		ctl.abort();
		let done = false;
		void sleep(60_000, ctl.signal).then(() => (done = true));
		await vi.advanceTimersByTimeAsync(0);
		expect(done).toBe(true);
	});
});
