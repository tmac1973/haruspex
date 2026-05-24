import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn()
}));

import { invoke } from '@tauri-apps/api/core';

import {
	scheduleToConfigJson,
	configJsonToSchedule,
	computeNextDueAt,
	type JobSummary,
	type JobWithSteps,
	type JobInput
} from '$lib/stores/jobs.svelte';

const baseInput: JobInput = {
	name: 'Test job',
	description: null,
	working_dir: '/tmp/work',
	auto_approve_tools: false,
	schedule_kind: 'manual',
	schedule_config: null,
	next_due_at: null
};

const summary = (id: number, name: string, overrides: Partial<JobSummary> = {}): JobSummary => ({
	id,
	name,
	description: null,
	working_dir: '/tmp/work',
	auto_approve_tools: false,
	schedule_kind: 'manual',
	schedule_config: null,
	next_due_at: null,
	created_at: 0,
	updated_at: 0,
	step_count: 0,
	...overrides
});

describe('jobs store schedule helpers', () => {
	it('serializes manual and hourly as null', () => {
		expect(scheduleToConfigJson({ kind: 'manual' })).toBeNull();
		expect(scheduleToConfigJson({ kind: 'hourly' })).toBeNull();
	});

	it('serializes daily with time', () => {
		expect(scheduleToConfigJson({ kind: 'daily', time: '09:30' })).toBe('{"time":"09:30"}');
	});

	it('serializes weekly with day + time', () => {
		expect(scheduleToConfigJson({ kind: 'weekly', day: 'mon', time: '08:00' })).toBe(
			'{"day":"mon","time":"08:00"}'
		);
	});

	it('serializes interval with minutes', () => {
		expect(scheduleToConfigJson({ kind: 'interval', minutes: 15 })).toBe('{"minutes":15}');
	});

	it('round-trips daily through deserialization', () => {
		const json = scheduleToConfigJson({ kind: 'daily', time: '14:45' });
		expect(configJsonToSchedule('daily', json)).toEqual({ kind: 'daily', time: '14:45' });
	});

	it('round-trips weekly through deserialization', () => {
		const json = scheduleToConfigJson({ kind: 'weekly', day: 'fri', time: '17:00' });
		expect(configJsonToSchedule('weekly', json)).toEqual({
			kind: 'weekly',
			day: 'fri',
			time: '17:00'
		});
	});

	it('round-trips interval through deserialization', () => {
		const json = scheduleToConfigJson({ kind: 'interval', minutes: 30 });
		expect(configJsonToSchedule('interval', json)).toEqual({ kind: 'interval', minutes: 30 });
	});

	it('returns manual/hourly even when config is missing', () => {
		expect(configJsonToSchedule('manual', null)).toEqual({ kind: 'manual' });
		expect(configJsonToSchedule('hourly', null)).toEqual({ kind: 'hourly' });
	});

	it('returns null for malformed configs', () => {
		expect(configJsonToSchedule('daily', null)).toBeNull();
		expect(configJsonToSchedule('daily', 'not-json')).toBeNull();
		expect(configJsonToSchedule('weekly', '{"day":"mon"}')).toBeNull();
		expect(configJsonToSchedule('interval', '{}')).toBeNull();
	});
});

describe('computeNextDueAt', () => {
	it('returns null for manual', () => {
		expect(computeNextDueAt({ kind: 'manual' }, null)).toBeNull();
	});

	it('hourly rounds up to the next top of hour', () => {
		// Tuesday 2026-03-10 14:23:45 local — anchor with a fixed Date
		const now = new Date(2026, 2, 10, 14, 23, 45);
		const next = computeNextDueAt({ kind: 'hourly' }, null, now);
		expect(next).not.toBeNull();
		// Hours align UTC and local — the next top-of-hour ms is divisible
		// by 3,600,000 (no minutes/seconds/ms remainder).
		expect((next as number) % 3_600_000).toBe(0);
		expect(next as number).toBeGreaterThan(now.getTime());
		// And it's the *next* hour, not the one after.
		expect((next as number) - now.getTime()).toBeLessThanOrEqual(3_600_000);
	});

	it('daily picks today if HH:MM is still in the future, else tomorrow', () => {
		const morning = new Date(2026, 2, 10, 8, 0, 0);
		const nextToday = computeNextDueAt({ kind: 'daily', time: '17:30' }, null, morning);
		const todayTarget = new Date(2026, 2, 10, 17, 30, 0).getTime();
		expect(nextToday).toBe(todayTarget);

		const evening = new Date(2026, 2, 10, 18, 0, 0);
		const nextTomorrow = computeNextDueAt({ kind: 'daily', time: '17:30' }, null, evening);
		const tomorrowTarget = new Date(2026, 2, 11, 17, 30, 0).getTime();
		expect(nextTomorrow).toBe(tomorrowTarget);
	});

	it('weekly picks the next occurrence of the named weekday', () => {
		// 2026-03-10 is a Tuesday.
		const tue = new Date(2026, 2, 10, 12, 0, 0);
		// Asking for Friday at 09:00 → Friday 2026-03-13 09:00.
		const fri = computeNextDueAt({ kind: 'weekly', day: 'fri', time: '09:00' }, null, tue);
		expect(fri).toBe(new Date(2026, 2, 13, 9, 0, 0).getTime());

		// Asking for Tuesday at 09:00 on a Tuesday at noon → next Tuesday.
		const nextTue = computeNextDueAt({ kind: 'weekly', day: 'tue', time: '09:00' }, null, tue);
		expect(nextTue).toBe(new Date(2026, 2, 17, 9, 0, 0).getTime());

		// Asking for Tuesday at 17:00 on a Tuesday at noon → today.
		const todayLater = computeNextDueAt({ kind: 'weekly', day: 'tue', time: '17:00' }, null, tue);
		expect(todayLater).toBe(new Date(2026, 2, 10, 17, 0, 0).getTime());
	});

	it('interval anchored on prevDue when provided', () => {
		const now = new Date(2026, 2, 10, 12, 0, 0).getTime();
		const prev = now - 2 * 60_000; // 2 minutes ago
		const next = computeNextDueAt({ kind: 'interval', minutes: 5 }, prev, new Date(now));
		// prev + 5min = 3 minutes in the future (still > now), so we use it directly.
		expect(next).toBe(prev + 5 * 60_000);
	});

	it('interval anchored on now when prevDue is null', () => {
		const now = new Date(2026, 2, 10, 12, 0, 0);
		const next = computeNextDueAt({ kind: 'interval', minutes: 15 }, null, now);
		expect(next).toBe(now.getTime() + 15 * 60_000);
	});

	it('interval skips ahead by missed intervals if we drifted behind', () => {
		// prevDue was 25 minutes ago and the interval is 10 minutes — we're
		// 2.5 intervals behind. Next should be the first future
		// prev + N*interval that's after now (not a burst of catch-up).
		const now = new Date(2026, 2, 10, 12, 0, 0).getTime();
		const prev = now - 25 * 60_000;
		const next = computeNextDueAt({ kind: 'interval', minutes: 10 }, prev, new Date(now));
		// prev + 10 = -15m past, prev + 20 = -5m past, prev + 30 = +5m future ⇒ pick +5m.
		expect(next).toBe(prev + 30 * 60_000);
		expect(next as number).toBeGreaterThan(now);
	});
});

describe('jobs store CRUD', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	it('loadJobs invokes db_list_jobs and stores the result', async () => {
		const rows = [summary(1, 'A'), summary(2, 'B')];
		vi.mocked(invoke).mockResolvedValueOnce(rows);

		const { loadJobs, getJobs, isJobsLoaded } = await import('$lib/stores/jobs.svelte');
		await loadJobs();

		expect(invoke).toHaveBeenCalledWith('db_list_jobs');
		expect(getJobs()).toEqual(rows);
		expect(isJobsLoaded()).toBe(true);
	});

	it('loadJobs returns an empty list when the invoke fails', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('db gone'));

		const { loadJobs, getJobs, isJobsLoaded } = await import('$lib/stores/jobs.svelte');
		await loadJobs();

		expect(getJobs()).toEqual([]);
		expect(isJobsLoaded()).toBe(true);
	});

	it('createJob forwards the input and refreshes the list', async () => {
		vi.mocked(invoke)
			.mockResolvedValueOnce(42) // db_create_job
			.mockResolvedValueOnce([summary(42, 'Test job')]); // db_list_jobs

		const { createJob, getJobs } = await import('$lib/stores/jobs.svelte');
		const id = await createJob(baseInput);

		expect(id).toBe(42);
		expect(invoke).toHaveBeenNthCalledWith(1, 'db_create_job', { input: baseInput });
		expect(invoke).toHaveBeenNthCalledWith(2, 'db_list_jobs');
		expect(getJobs()).toEqual([summary(42, 'Test job')]);
	});

	it('createJob returns null when the invoke fails', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('insert failed'));

		const { createJob } = await import('$lib/stores/jobs.svelte');
		const id = await createJob(baseInput);

		expect(id).toBeNull();
	});

	it('updateJob calls db_update_job with id + input and refreshes the list', async () => {
		vi.mocked(invoke)
			.mockResolvedValueOnce(undefined) // db_update_job
			.mockResolvedValueOnce([summary(7, 'Renamed')]); // db_list_jobs

		const { updateJob, getJobs } = await import('$lib/stores/jobs.svelte');
		const renamedInput = { ...baseInput, name: 'Renamed' };
		const ok = await updateJob(7, renamedInput);

		expect(ok).toBe(true);
		expect(invoke).toHaveBeenNthCalledWith(1, 'db_update_job', { id: 7, input: renamedInput });
		expect(getJobs()[0].name).toBe('Renamed');
	});

	it('deleteJob calls db_delete_job and refreshes the list', async () => {
		vi.mocked(invoke)
			.mockResolvedValueOnce(undefined) // db_delete_job
			.mockResolvedValueOnce([]); // db_list_jobs

		const { deleteJob, getJobs } = await import('$lib/stores/jobs.svelte');
		const ok = await deleteJob(3);

		expect(ok).toBe(true);
		expect(invoke).toHaveBeenNthCalledWith(1, 'db_delete_job', { id: 3 });
		expect(getJobs()).toEqual([]);
	});

	it('getJob returns the full job-with-steps shape', async () => {
		const full: JobWithSteps = {
			id: 1,
			name: 'Full',
			description: null,
			working_dir: '/tmp',
			auto_approve_tools: false,
			schedule_kind: 'manual',
			schedule_config: null,
			next_due_at: null,
			created_at: 0,
			updated_at: 0,
			steps: [{ id: 10, ordering: 0, prompt: 'do thing', deep_research: true }]
		};
		vi.mocked(invoke).mockResolvedValueOnce(full);

		const { getJob } = await import('$lib/stores/jobs.svelte');
		const result = await getJob(1);

		expect(invoke).toHaveBeenCalledWith('db_get_job', { id: 1 });
		expect(result).toEqual(full);
	});

	it('getJob returns null on failure', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('not found'));

		const { getJob } = await import('$lib/stores/jobs.svelte');
		const result = await getJob(999);
		expect(result).toBeNull();
	});

	it('replaceJobSteps forwards jobId + steps and refreshes the list', async () => {
		vi.mocked(invoke)
			.mockResolvedValueOnce(undefined) // db_replace_job_steps
			.mockResolvedValueOnce([summary(5, 'After step replace', { step_count: 2 })]); // db_list_jobs

		const { replaceJobSteps, getJobs } = await import('$lib/stores/jobs.svelte');
		const steps = [
			{ prompt: 'step a', deep_research: false },
			{ prompt: 'step b', deep_research: true }
		];
		const ok = await replaceJobSteps(5, steps);

		expect(ok).toBe(true);
		expect(invoke).toHaveBeenNthCalledWith(1, 'db_replace_job_steps', {
			jobId: 5,
			steps
		});
		expect(invoke).toHaveBeenNthCalledWith(2, 'db_list_jobs');
		// The refresh updates the cached step_count so the Run button
		// enables immediately after the very first save.
		expect(getJobs()[0].step_count).toBe(2);
	});

	it('replaceJobSteps returns false on failure', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('boom'));
		const { replaceJobSteps } = await import('$lib/stores/jobs.svelte');
		const ok = await replaceJobSteps(5, [{ prompt: 'x', deep_research: false }]);
		expect(ok).toBe(false);
	});

	it('listDueJobs forwards nowMs and returns the rows', async () => {
		const rows = [summary(1, 'A')];
		vi.mocked(invoke).mockResolvedValueOnce(rows);
		const { listDueJobs } = await import('$lib/stores/jobs.svelte');
		const result = await listDueJobs(12345);
		expect(invoke).toHaveBeenCalledWith('db_list_due_jobs', { nowMs: 12345 });
		expect(result).toEqual(rows);
	});

	it('listDueJobs returns [] on failure', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('db down'));
		const { listDueJobs } = await import('$lib/stores/jobs.svelte');
		expect(await listDueJobs(0)).toEqual([]);
	});

	it('setJobNextDueAt forwards jobId + nextDueAt', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(undefined);
		const { setJobNextDueAt } = await import('$lib/stores/jobs.svelte');
		await setJobNextDueAt(7, 99999);
		expect(invoke).toHaveBeenCalledWith('db_set_job_next_due_at', {
			jobId: 7,
			nextDueAt: 99999
		});
	});

	it('setJobNextDueAt passes null through', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(undefined);
		const { setJobNextDueAt } = await import('$lib/stores/jobs.svelte');
		await setJobNextDueAt(7, null);
		expect(invoke).toHaveBeenCalledWith('db_set_job_next_due_at', {
			jobId: 7,
			nextDueAt: null
		});
	});
});
