import { describe, it, expect, beforeEach } from 'vitest';
import {
	askFileConflict,
	getPendingConflict,
	resolveConflict
} from '$lib/stores/fileConflict.svelte';

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

	it('rejects overlapping requests', async () => {
		const first = askFileConflict('a.pdf');
		// Second call while first is still pending should reject, not
		// queue — overlap is a caller bug we want to surface loudly.
		await expect(askFileConflict('b.pdf')).rejects.toThrow(/already pending/);
		// First request is still intact and resolvable.
		resolveConflict('cancel');
		await expect(first).resolves.toBe('cancel');
	});

	it('resolveConflict is a no-op when nothing is pending', () => {
		expect(getPendingConflict()).toBeNull();
		// Should not throw.
		resolveConflict('overwrite');
		expect(getPendingConflict()).toBeNull();
	});
});
