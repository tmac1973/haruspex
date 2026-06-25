import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JobSummary } from '$lib/stores/jobs.svelte';

const mocks = vi.hoisted(() => ({
	listDueJobs: vi.fn(),
	setJobNextDueAt: vi.fn(),
	enqueue: vi.fn()
}));

vi.mock('$lib/stores/jobs.svelte', async () => {
	// Re-export real schedule helpers so the scheduler's
	// configJsonToSchedule + computeNextDueAt work, but mock the
	// invoke-backed CRUD.
	const actual =
		await vi.importActual<typeof import('$lib/stores/jobs.svelte')>('$lib/stores/jobs.svelte');
	return {
		...actual,
		listDueJobs: mocks.listDueJobs,
		setJobNextDueAt: mocks.setJobNextDueAt
	};
});

vi.mock('$lib/agent/jobs/runner.svelte', () => ({
	enqueue: mocks.enqueue
}));

import { tick, startScheduler, stopScheduler } from '$lib/agent/jobs/scheduler.svelte';

function dueJob(overrides: Partial<JobSummary>): JobSummary {
	return {
		id: 1,
		name: 'Test job',
		description: null,
		working_dir: '/tmp',
		auto_approve_tools: true,
		job_type: 'research',
		schedule_kind: 'interval',
		schedule_config: '{"minutes":5}',
		next_due_at: 100,
		created_at: 0,
		updated_at: 0,
		step_count: 1,
		...overrides
	};
}

beforeEach(() => {
	mocks.listDueJobs.mockReset();
	mocks.setJobNextDueAt.mockReset().mockResolvedValue(undefined);
	mocks.enqueue.mockReset().mockResolvedValue(1);
});

afterEach(() => {
	stopScheduler();
});

describe('scheduler tick', () => {
	it('enqueues each due job and recomputes its next due time', async () => {
		const now = Date.now();
		mocks.listDueJobs.mockResolvedValueOnce([
			dueJob({ id: 1, next_due_at: now - 1000 }),
			dueJob({ id: 2, next_due_at: now - 2000 })
		]);

		await tick();

		expect(mocks.listDueJobs).toHaveBeenCalledWith(expect.any(Number));
		expect(mocks.enqueue).toHaveBeenCalledTimes(2);
		expect(mocks.enqueue.mock.calls[0]).toEqual([1, 'scheduled']);
		expect(mocks.enqueue.mock.calls[1]).toEqual([2, 'scheduled']);

		// Recompute fires for both jobs with a future timestamp. The exact
		// value depends on the interval logic; here we just assert it's >=
		// now (since the test job is interval=5min anchored on past due).
		expect(mocks.setJobNextDueAt).toHaveBeenCalledTimes(2);
		expect(mocks.setJobNextDueAt.mock.calls[0][0]).toBe(1);
		expect(mocks.setJobNextDueAt.mock.calls[1][0]).toBe(2);
		for (const call of mocks.setJobNextDueAt.mock.calls) {
			expect(call[1]).toBeGreaterThanOrEqual(now);
		}
	});

	it('clears next_due_at and still enqueues if schedule_config is malformed', async () => {
		mocks.listDueJobs.mockResolvedValueOnce([
			dueJob({ id: 1, schedule_kind: 'daily', schedule_config: 'not-json' })
		]);

		await tick();

		expect(mocks.setJobNextDueAt).toHaveBeenCalledWith(1, null);
		expect(mocks.enqueue).toHaveBeenCalledWith(1, 'scheduled');
	});

	it('is a no-op when no jobs are due', async () => {
		mocks.listDueJobs.mockResolvedValueOnce([]);
		await tick();
		expect(mocks.enqueue).not.toHaveBeenCalled();
		expect(mocks.setJobNextDueAt).not.toHaveBeenCalled();
	});

	it('swallows DB errors without crashing the ticker', async () => {
		mocks.listDueJobs.mockRejectedValueOnce(new Error('db down'));
		// Should not throw.
		await tick();
		expect(mocks.enqueue).not.toHaveBeenCalled();
	});

	it('startScheduler fires an immediate tick and installs exactly one interval', async () => {
		vi.useFakeTimers();
		try {
			mocks.listDueJobs.mockResolvedValue([]);
			startScheduler();
			// The immediate `void tick()` is awaiting the listDueJobs promise;
			// flush microtasks so it resolves before we count.
			await Promise.resolve();
			await Promise.resolve();
			expect(mocks.listDueJobs).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('startScheduler is idempotent — a second call does not stack timers', async () => {
		vi.useFakeTimers();
		try {
			mocks.listDueJobs.mockResolvedValue([]);
			startScheduler();
			startScheduler();
			startScheduler();
			await Promise.resolve();
			await Promise.resolve();
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('stopScheduler clears the interval', () => {
		vi.useFakeTimers();
		try {
			mocks.listDueJobs.mockResolvedValue([]);
			startScheduler();
			expect(vi.getTimerCount()).toBe(1);
			stopScheduler();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
