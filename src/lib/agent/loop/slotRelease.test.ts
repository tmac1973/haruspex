import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runReleasingSlot, SLOT_RELEASE_AFTER_MS } from './slotRelease';

function fakeSlot(held = true) {
	return { held, release: vi.fn(), reacquire: vi.fn(async () => {}) };
}

function after(ms: number, value = 'ok') {
	return () => new Promise<string>((r) => setTimeout(() => r(value), ms));
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('runReleasingSlot', () => {
	it('keeps the slot through a short batch', async () => {
		const slot = fakeSlot();
		const p = runReleasingSlot(slot, after(1_000));
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(p).resolves.toBe('ok');
		await vi.advanceTimersByTimeAsync(SLOT_RELEASE_AFTER_MS);
		expect(slot.release).not.toHaveBeenCalled();
	});

	it('gives the slot back once a batch has run 5 s, and never takes it back', async () => {
		const slot = fakeSlot();
		const p = runReleasingSlot(slot, after(30_000));
		await vi.advanceTimersByTimeAsync(SLOT_RELEASE_AFTER_MS - 1);
		expect(slot.release).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(slot.release).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(p).resolves.toBe('ok');
		expect(slot.release).toHaveBeenCalledTimes(1);
		expect(slot.reacquire).not.toHaveBeenCalled();
	});

	it('just runs with no slot, or one not held', async () => {
		const p = runReleasingSlot(undefined, after(10_000));
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(p).resolves.toBe('ok');

		const slot = fakeSlot(false);
		const q = runReleasingSlot(slot, after(10_000));
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(q).resolves.toBe('ok');
		expect(slot.release).not.toHaveBeenCalled();
	});

	it('clears its timer when the batch throws', async () => {
		const slot = fakeSlot();
		await expect(
			runReleasingSlot(slot, async () => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		await vi.advanceTimersByTimeAsync(SLOT_RELEASE_AFTER_MS);
		expect(slot.release).not.toHaveBeenCalled();
	});
});
