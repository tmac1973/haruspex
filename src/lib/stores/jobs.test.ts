import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn()
}));

import { invoke } from '@tauri-apps/api/core';

import {
	scheduleToConfigJson,
	configJsonToSchedule,
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
	schedule_config: null
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

	it('replaceJobSteps forwards jobId and steps', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(undefined);

		const { replaceJobSteps } = await import('$lib/stores/jobs.svelte');
		const steps = [
			{ prompt: 'step a', deep_research: false },
			{ prompt: 'step b', deep_research: true }
		];
		const ok = await replaceJobSteps(5, steps);

		expect(ok).toBe(true);
		expect(invoke).toHaveBeenCalledWith('db_replace_job_steps', {
			jobId: 5,
			steps
		});
	});

	it('replaceJobSteps returns false on failure', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('boom'));
		const { replaceJobSteps } = await import('$lib/stores/jobs.svelte');
		const ok = await replaceJobSteps(5, [{ prompt: 'x', deep_research: false }]);
		expect(ok).toBe(false);
	});
});
