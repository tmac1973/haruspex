import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn()
}));

import { invoke } from '@tauri-apps/api/core';
import type { JobRunSummary, JobRunWithSteps } from '$lib/stores/jobRuns.svelte';

const summary = (id: number, jobId = 1, overrides: Partial<JobRunSummary> = {}): JobRunSummary => ({
	id,
	job_id: jobId,
	status: 'succeeded',
	trigger: 'manual',
	queued_at: 1000 + id,
	started_at: 2000 + id,
	finished_at: 3000 + id,
	error: null,
	...overrides
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe('jobRuns store', () => {
	it('loadRunsForJob fetches and caches per-job rows', async () => {
		const rows = [summary(2), summary(1)];
		vi.mocked(invoke).mockResolvedValueOnce(rows);

		const { loadRunsForJob, getRunsForJob } = await import('$lib/stores/jobRuns.svelte');
		await loadRunsForJob(1);

		expect(invoke).toHaveBeenCalledWith('db_list_job_runs', { jobId: 1 });
		expect(getRunsForJob(1)).toEqual(rows);
	});

	it('loadRunsForJob falls back to empty on error', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('db down'));

		const { loadRunsForJob, getRunsForJob } = await import('$lib/stores/jobRuns.svelte');
		await loadRunsForJob(9);
		expect(getRunsForJob(9)).toEqual([]);
	});

	it('getRunsForJob returns [] for an unloaded job', async () => {
		const { getRunsForJob } = await import('$lib/stores/jobRuns.svelte');
		expect(getRunsForJob(42)).toEqual([]);
	});

	it('createJobRun forwards jobId, trigger, stepPrompts and returns the new id', async () => {
		vi.mocked(invoke)
			.mockResolvedValueOnce(77) // db_create_job_run
			.mockResolvedValueOnce([summary(77)]); // automatic loadRunsForJob refresh

		const { createJobRun } = await import('$lib/stores/jobRuns.svelte');
		const id = await createJobRun(1, 'scheduled', ['a', 'b']);

		expect(id).toBe(77);
		expect(invoke).toHaveBeenNthCalledWith(1, 'db_create_job_run', {
			jobId: 1,
			trigger: 'scheduled',
			stepPrompts: ['a', 'b']
		});
		expect(invoke).toHaveBeenNthCalledWith(2, 'db_list_job_runs', { jobId: 1 });
	});

	it('createJobRun returns null on failure', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('insert failed'));
		const { createJobRun } = await import('$lib/stores/jobRuns.svelte');
		const id = await createJobRun(1, 'manual', ['only']);
		expect(id).toBeNull();
	});

	it('markRunStarted invokes db_mark_run_started with start time', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(undefined);
		const { markRunStarted } = await import('$lib/stores/jobRuns.svelte');
		await markRunStarted(5, 9999);
		expect(invoke).toHaveBeenCalledWith('db_mark_run_started', { runId: 5, startedAt: 9999 });
	});

	it('markRunFinished invokes the finish command and refreshes the job list', async () => {
		vi.mocked(invoke)
			.mockResolvedValueOnce(undefined) // db_mark_run_finished
			.mockResolvedValueOnce([summary(5)]); // db_list_job_runs

		const { markRunFinished } = await import('$lib/stores/jobRuns.svelte');
		await markRunFinished(5, 1, 'failed', 12345, 'oops');

		expect(invoke).toHaveBeenNthCalledWith(1, 'db_mark_run_finished', {
			runId: 5,
			status: 'failed',
			finishedAt: 12345,
			error: 'oops'
		});
		expect(invoke).toHaveBeenNthCalledWith(2, 'db_list_job_runs', { jobId: 1 });
	});

	it('markRunStepStarted forwards run + ordering + rendered prompt', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(undefined);
		const { markRunStepStarted } = await import('$lib/stores/jobRuns.svelte');
		await markRunStepStarted(5, 2, 500, 'rendered prompt');
		expect(invoke).toHaveBeenCalledWith('db_mark_run_step_started', {
			runId: 5,
			ordering: 2,
			startedAt: 500,
			promptRendered: 'rendered prompt'
		});
	});

	it('markRunStepFinished forwards status, output, error, finishedAt', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(undefined);
		const { markRunStepFinished } = await import('$lib/stores/jobRuns.svelte');
		await markRunStepFinished(5, 0, 'succeeded', 'out', null, 600);
		expect(invoke).toHaveBeenCalledWith('db_mark_run_step_finished', {
			runId: 5,
			ordering: 0,
			status: 'succeeded',
			output: 'out',
			error: null,
			finishedAt: 600
		});
	});

	it('getJobRun returns the full payload', async () => {
		const full: JobRunWithSteps = {
			id: 10,
			job_id: 1,
			status: 'succeeded',
			trigger: 'manual',
			queued_at: 1,
			started_at: 2,
			finished_at: 3,
			error: null,
			steps: [
				{
					id: 100,
					run_id: 10,
					ordering: 0,
					prompt_authored: 'a',
					prompt_rendered: 'a',
					status: 'succeeded',
					output: 'done',
					started_at: 2,
					finished_at: 3,
					error: null
				}
			]
		};
		vi.mocked(invoke).mockResolvedValueOnce(full);

		const { getJobRun } = await import('$lib/stores/jobRuns.svelte');
		const result = await getJobRun(10);
		expect(invoke).toHaveBeenCalledWith('db_get_job_run', { runId: 10 });
		expect(result).toEqual(full);
	});

	it('getJobRun returns null on failure', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('not found'));
		const { getJobRun } = await import('$lib/stores/jobRuns.svelte');
		expect(await getJobRun(999)).toBeNull();
	});
});
