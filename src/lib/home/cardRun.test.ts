import { describe, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({
	active: null as { status: string; waitingForSlot?: boolean } | null,
	queue: [] as { jobId: number }[],
	latest: null as { latest: { status: string } | null } | null
}));
vi.mock('#lib/agent/jobs/runner.svelte.ts', () => ({
	getActiveRunForJob: () => state.active,
	getPendingQueue: () => state.queue
}));
vi.mock('#lib/home/latestRun.svelte.ts', () => ({ getLatestRun: () => state.latest }));

import { cardRunState, jobQueued } from './cardRun.ts';

describe('cardRunState', () => {
	it('is all quiet for a card with no job', () => {
		expect(cardRunState(null)).toMatchObject({ running: false, queued: false, failed: null });
	});

	it('says a run waits for a slot only while it runs', () => {
		state.active = { status: 'running', waitingForSlot: true };
		expect(cardRunState(1)).toMatchObject({ running: true, waiting: true });
		state.active = { status: 'succeeded', waitingForSlot: true };
		expect(cardRunState(1).waiting).toBe(false);
	});

	it('reports the latest run when it failed', () => {
		state.latest = { latest: { status: 'failed' } };
		expect(cardRunState(1).failed).toEqual({ status: 'failed' });
	});
});

describe('jobQueued', () => {
	it('finds the job in the queue', () => {
		state.queue = [{ jobId: 4 }];
		expect(jobQueued(4)).toBe(true);
		expect(jobQueued(5)).toBe(false);
		expect(jobQueued(null)).toBe(false);
	});
});
