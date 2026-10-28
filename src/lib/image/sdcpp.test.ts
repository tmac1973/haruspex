import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { retryEmptyResult } from './sdcpp';

const EMPTY = new Error('500: generate_image returned no results');

describe('retryEmptyResult', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('retries the spurious empty result and returns the next answer', async () => {
		const attempt = vi.fn().mockRejectedValueOnce(EMPTY).mockResolvedValueOnce('ok');
		const out = retryEmptyResult(attempt);
		await vi.runAllTimersAsync();
		await expect(out).resolves.toBe('ok');
		expect(attempt).toHaveBeenCalledTimes(2);
	});

	it('gives up after three attempts with the last error', async () => {
		const attempt = vi.fn().mockRejectedValue(EMPTY);
		const out = retryEmptyResult(attempt);
		const settled = expect(out).rejects.toBe(EMPTY);
		await vi.runAllTimersAsync();
		await settled;
		expect(attempt).toHaveBeenCalledTimes(3);
	});

	it('does not retry any other failure', async () => {
		const other = new Error('connection refused');
		const attempt = vi.fn().mockRejectedValue(other);
		await expect(retryEmptyResult(attempt)).rejects.toBe(other);
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it('does not retry once the signal aborted', async () => {
		const ctl = new AbortController();
		ctl.abort();
		const attempt = vi.fn().mockRejectedValue(EMPTY);
		await expect(retryEmptyResult(attempt, ctl.signal)).rejects.toBe(EMPTY);
		expect(attempt).toHaveBeenCalledTimes(1);
	});
});
