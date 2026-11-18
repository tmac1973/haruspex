import { describe, it, expect, beforeEach } from 'vitest';
import {
	askFileConflict,
	getPendingConflict,
	resolveConflict
} from '#lib/stores/fileConflict.svelte.ts';

describe('fileConflict store', () => {
	beforeEach(() => {
		// Clear any leftover pending state from prior tests by pretending
		// the user clicked cancel. Safe no-op if nothing is pending.
		resolveConflict('cancel');
	});

	it('starts with no pending conflict', () => {
		expect(getPendingConflict()).toBeNull();
	});

	it('askFileConflict publishes a pending request', async () => {
		const pathPromise = askFileConflict('report.pdf');
		// Pending should be visible immediately — the Promise doesn't
		// resolve until the modal resolves it.
		const pending = getPendingConflict();
		expect(pending).not.toBeNull();
		expect(pending?.path).toBe('report.pdf');

		// Resolve and confirm the Promise fires with our choice.
		resolveConflict('overwrite');
		await expect(pathPromise).resolves.toBe('overwrite');
		// Clearing happens synchronously inside resolveConflict.
		expect(getPendingConflict()).toBeNull();
	});

	it('each choice propagates correctly', async () => {
		for (const choice of ['overwrite', 'counter', 'cancel'] as const) {
			const p = askFileConflict(`test-${choice}.pdf`);
			resolveConflict(choice);
			await expect(p).resolves.toBe(choice);
		}
	});

	it('queues an overlapping request behind the first', async () => {
		const first = askFileConflict('a.pdf');
		const second = askFileConflict('b.pdf');
		expect(getPendingConflict()?.path).toBe('a.pdf');
		resolveConflict('cancel');
		await expect(first).resolves.toBe('cancel');
		expect(getPendingConflict()?.path).toBe('b.pdf');
		resolveConflict('overwrite');
		await expect(second).resolves.toBe('overwrite');
	});

	it('takes an aborted request out of the queue as a cancel', async () => {
		const first = askFileConflict('a.pdf');
		const ctrl = new AbortController();
		const second = askFileConflict('b.pdf', null, { signal: ctrl.signal });
		ctrl.abort();
		await expect(second).resolves.toBe('cancel');
		resolveConflict('counter');
		await expect(first).resolves.toBe('counter');
		expect(getPendingConflict()).toBeNull();
	});

	it('resolveConflict is a no-op when nothing is pending', () => {
		expect(getPendingConflict()).toBeNull();
		// Should not throw.
		resolveConflict('overwrite');
		expect(getPendingConflict()).toBeNull();
	});
});
