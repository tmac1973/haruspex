import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Module-level $state — re-import fresh per test so visible toasts,
// queued toasts, and timers can't leak between tests.
async function freshStore() {
	return import('$lib/stores/toasts.svelte');
}

describe('toasts store', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('info toasts auto-dismiss after 5000ms', async () => {
		const { showToast, getToasts } = await freshStore();
		showToast('saved');

		vi.advanceTimersByTime(4999);
		expect(getToasts()).toHaveLength(1);

		vi.advanceTimersByTime(1);
		expect(getToasts()).toHaveLength(0);
	});

	it('error toasts default to 8000ms', async () => {
		const { showToast, getToasts } = await freshStore();
		showToast('boom', { kind: 'error' });

		vi.advanceTimersByTime(7999);
		expect(getToasts()).toHaveLength(1);

		vi.advanceTimersByTime(1);
		expect(getToasts()).toHaveLength(0);
	});

	it('an explicit duration overrides the kind default', async () => {
		const { showToast, getToasts } = await freshStore();
		showToast('quick', { kind: 'error', duration: 1000 });

		vi.advanceTimersByTime(1000);
		expect(getToasts()).toHaveLength(0);
	});

	it('caps visible toasts at 4 and promotes overflow FIFO', async () => {
		const { showToast, dismissToast, getToasts } = await freshStore();
		for (const msg of ['t1', 't2', 't3', 't4', 't5', 't6']) showToast(msg);

		expect(getToasts().map((t) => t.message)).toEqual(['t1', 't2', 't3', 't4']);

		dismissToast(getToasts()[0].id);
		expect(getToasts().map((t) => t.message)).toEqual(['t2', 't3', 't4', 't5']);

		dismissToast(getToasts()[0].id);
		expect(getToasts().map((t) => t.message)).toEqual(['t3', 't4', 't5', 't6']);
	});

	it("a queued toast's timer only starts once it becomes visible", async () => {
		const { showToast, getToasts } = await freshStore();
		for (const msg of ['t1', 't2', 't3', 't4', 't5']) showToast(msg);

		// The four visible toasts expire together; t5 is promoted with a
		// fresh 5000ms timer rather than expiring alongside them.
		vi.advanceTimersByTime(5000);
		expect(getToasts().map((t) => t.message)).toEqual(['t5']);

		vi.advanceTimersByTime(5000);
		expect(getToasts()).toHaveLength(0);
	});

	it('a duplicate (kind, message) resets the timer instead of stacking', async () => {
		const { showToast, getToasts } = await freshStore();
		showToast('same');

		vi.advanceTimersByTime(3000);
		showToast('same');
		expect(getToasts()).toHaveLength(1);

		// 4999ms after the reset (7999ms after the original show) it's
		// still up; the full window elapses from the second show.
		vi.advanceTimersByTime(4999);
		expect(getToasts()).toHaveLength(1);

		vi.advanceTimersByTime(1);
		expect(getToasts()).toHaveLength(0);
	});

	it('same message with a different kind stacks separately', async () => {
		const { showToast, getToasts } = await freshStore();
		showToast('same');
		showToast('same', { kind: 'error' });

		expect(getToasts()).toHaveLength(2);
	});

	it('dismissing an unknown id is a no-op', async () => {
		const { showToast, dismissToast, getToasts } = await freshStore();
		showToast('keep');

		expect(() => dismissToast(999)).not.toThrow();
		expect(getToasts()).toHaveLength(1);
	});
});
