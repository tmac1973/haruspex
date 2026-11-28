import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleep, sleepOrAbort } from './async';

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

describe('sleepOrAbort', () => {
	it('resolves after the wait when nothing aborts', async () => {
		vi.useFakeTimers();
		try {
			const p = sleepOrAbort(100);
			await vi.advanceTimersByTimeAsync(100);
			await expect(p).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('throws an AbortError when the signal aborts during the wait, or already has', async () => {
		const c = new AbortController();
		const p = sleepOrAbort(60_000, c.signal);
		c.abort();
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
		await expect(sleepOrAbort(10, c.signal)).rejects.toMatchObject({ name: 'AbortError' });
	});
});
