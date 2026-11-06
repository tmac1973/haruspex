import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JobSummary } from '#lib/stores/jobs.svelte.ts';

const mocks = vi.hoisted(() => ({
	listDueJobs: vi.fn(),
	setJobNextDueAt: vi.fn(),
	enqueue: vi.fn(),
	homeTab: true,
	cards: [] as { job_id: number | null; card_type: string; config?: string }[]
}));

vi.mock('#lib/stores/settings.ts', () => ({
	getSettings: () => ({ homeTab: mocks.homeTab })
}));

vi.mock('#lib/stores/homeCards.svelte.ts', () => ({
	loadHomeCards: () => Promise.resolve(),
	getHomeCards: () => mocks.cards,
	cardUsesExistingJob: (c: { config?: string }) => c.config === '{"existingJob":true}'
}));

vi.mock('#lib/stores/jobs.svelte.ts', async () => {
	// Re-export real schedule helpers so the scheduler's
	// configJsonToSchedule + computeNextDueAt work, but mock the
	// invoke-backed CRUD.
	const actual = await vi.importActual<typeof import('#lib/stores/jobs.svelte.ts')>(
		'#lib/stores/jobs.svelte.ts'
	);
	return {
		...actual,
		listDueJobs: mocks.listDueJobs,
		setJobNextDueAt: mocks.setJobNextDueAt
	};
});

vi.mock('#lib/agent/jobs/runner.svelte.ts', () => ({
	enqueue: mocks.enqueue
}));

import { tick, startScheduler, stopScheduler } from '#lib/agent/jobs/scheduler.svelte.ts';

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
		parent_job_id: null,
		parent_run_id: null,
		...overrides
	};
}

beforeEach(() => {
	mocks.listDueJobs.mockReset();
	mocks.setJobNextDueAt.mockReset().mockResolvedValue(undefined);
	mocks.enqueue.mockReset().mockResolvedValue(1);
	mocks.homeTab = true;
	mocks.cards = [];
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

	it('runs a job missed while the app was closed once, then schedules ahead of now', async () => {
		// Due three intervals ago: the app was closed through all three.
		const now = Date.now();
		const fiveMin = 5 * 60_000;
		mocks.listDueJobs.mockResolvedValueOnce([dueJob({ id: 4, next_due_at: now - 3 * fiveMin })]);
		await tick();
		expect(mocks.enqueue).toHaveBeenCalledTimes(1);
		expect(mocks.enqueue).toHaveBeenCalledWith(4, 'scheduled');
		const next = mocks.setJobNextDueAt.mock.calls[0][1] as number;
		expect(next).toBeGreaterThan(now);
	});

	it("skips a Home card's job while the Home tab is off, but not a pinned one", async () => {
		mocks.cards = [
			{ job_id: 1, card_type: 'important_emails' },
			{ job_id: 2, card_type: 'pinned_job' },
			{ job_id: 3, card_type: 'news', config: '{"existingJob":true}' }
		];
		mocks.listDueJobs.mockResolvedValue([dueJob({ id: 1 }), dueJob({ id: 2 }), dueJob({ id: 3 })]);
		mocks.homeTab = false;
		await tick();
		expect(mocks.enqueue.mock.calls).toEqual([
			[2, 'scheduled'],
			[3, 'scheduled']
		]);
		// Its next due time still moves on, so it isn't due again every tick.
		expect(mocks.setJobNextDueAt).toHaveBeenCalledTimes(3);

		mocks.enqueue.mockClear();
		mocks.homeTab = true;
		await tick();
		expect(mocks.enqueue.mock.calls).toEqual([
			[1, 'scheduled'],
			[2, 'scheduled'],
			[3, 'scheduled']
		]);
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

/**
 * Guided planning and autonomous coding open their runs by interviewing the
 * user. Fired unattended, the run parks on a question modal with nobody there
 * and holds the runner while everything else queues behind it. The editor
 * hides the schedule field for those types, so a due job of one can only be
 * a row saved before that gate existed.
 */
describe('scheduler — types that cannot run unattended', () => {
	for (const jobType of ['guided_planning', 'autonomous_coding'] as const) {
		it(`never enqueues a due ${jobType} job`, async () => {
			mocks.listDueJobs.mockResolvedValue([dueJob({ job_type: jobType })]);

			await tick();

			expect(mocks.enqueue).not.toHaveBeenCalled();
		});

		it(`clears the due time so ${jobType} is not re-examined every tick`, async () => {
			mocks.listDueJobs.mockResolvedValue([dueJob({ id: 4, job_type: jobType })]);

			await tick();

			expect(mocks.setJobNextDueAt).toHaveBeenCalledWith(4, null);
		});
	}

	it('still runs the schedulable types alongside them', async () => {
		mocks.listDueJobs.mockResolvedValue([
			dueJob({ id: 1, job_type: 'guided_planning' }),
			dueJob({ id: 2, job_type: 'research' })
		]);

		await tick();

		expect(mocks.enqueue).toHaveBeenCalledTimes(1);
		expect(mocks.enqueue).toHaveBeenCalledWith(2, 'scheduled');
	});
});
