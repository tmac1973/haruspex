import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRunSummary, JobRunWithSteps } from '#lib/stores/jobRuns.svelte.ts';

const store = vi.hoisted(() => ({
	runs: [] as JobRunSummary[],
	loadRunsForJob: vi.fn(async () => {}),
	getJobRun: vi.fn()
}));

vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	getRunsForJob: () => store.runs,
	loadRunsForJob: store.loadRunsForJob,
	getJobRun: store.getJobRun
}));

import { _resetForTests, finalOutput, getLatestRun } from './latestRun.svelte';

function summary(id: number, status: string): JobRunSummary {
	return { id, job_id: 1, status } as JobRunSummary;
}

function withSteps(id: number, status: string, outputs: (string | null)[]): JobRunWithSteps {
	return {
		...summary(id, status),
		steps: outputs.map((output, ordering) => ({ ordering, output }))
	} as JobRunWithSteps;
}

beforeEach(() => {
	_resetForTests();
	store.runs = [];
	store.loadRunsForJob.mockClear();
	store.getJobRun.mockReset();
});

describe('getLatestRun', () => {
	it('loads a job’s runs once', () => {
		getLatestRun(1);
		getLatestRun(1);
		expect(store.loadRunsForJob).toHaveBeenCalledTimes(1);
		expect(getLatestRun(1)).toEqual({ latest: null, latestSucceeded: null });
	});

	it('gives the newest run, and the newest succeeded run with its steps', async () => {
		store.runs = [summary(9, 'failed'), summary(8, 'succeeded'), summary(7, 'succeeded')];
		store.getJobRun.mockResolvedValue(withSteps(8, 'succeeded', ['a', 'b']));

		const first = getLatestRun(1);
		expect(first.latest?.id).toBe(9);
		expect(first.latestSucceeded).toBeNull();
		await vi.waitFor(() => expect(getLatestRun(1).latestSucceeded?.id).toBe(8));
		expect(store.getJobRun).toHaveBeenCalledWith(8);
	});

	it('follows the run list when a newer run succeeds', async () => {
		store.runs = [summary(8, 'succeeded')];
		store.getJobRun.mockImplementation(async (id: number) => withSteps(id, 'succeeded', ['x']));
		getLatestRun(1);
		await vi.waitFor(() => expect(getLatestRun(1).latestSucceeded?.id).toBe(8));

		store.runs = [summary(10, 'succeeded'), summary(8, 'succeeded')];
		getLatestRun(1);
		await vi.waitFor(() => expect(getLatestRun(1).latestSucceeded?.id).toBe(10));
		expect(store.getJobRun).toHaveBeenCalledTimes(2);
	});
});

describe('finalOutput', () => {
	it('is the last step that wrote something', () => {
		expect(finalOutput(withSteps(1, 'succeeded', ['first', 'last']))).toBe('last');
		expect(finalOutput(withSteps(1, 'succeeded', ['first', null]))).toBe('first');
		expect(finalOutput(withSteps(1, 'succeeded', []))).toBeNull();
	});
});
