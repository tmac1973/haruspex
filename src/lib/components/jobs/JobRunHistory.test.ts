import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte';
import type { JobRunSummary } from '$lib/stores/jobRuns.svelte';

const state = vi.hoisted(() => ({
	runs: [] as JobRunSummary[],
	runningId: null as number | null,
	order: [] as string[]
}));

vi.mock('$lib/stores/jobRuns.svelte', () => ({
	getRunsForJob: () => state.runs,
	loadRunsForJob: vi.fn(),
	deleteJobRun: vi.fn(async (_job: number, id: number) => {
		state.order.push(`delete ${id}`);
		return true;
	}),
	deleteAllJobRuns: vi.fn(async () => {
		state.order.push('delete all');
		return true;
	})
}));
vi.mock('$lib/agent/jobs/runner.svelte', () => ({
	getRunningRunId: () => state.runningId,
	getCurrentRun: () => (state.runningId ? { jobId: 1, status: 'running' } : null),
	removeQueuedRun: vi.fn((id: number) => {
		state.order.push(`unqueue ${id}`);
		return true;
	}),
	removeQueuedRunsForJob: vi.fn(() => {
		state.order.push('unqueue job');
		return 0;
	})
}));

import JobRunHistory from './JobRunHistory.svelte';

function run(id: number, status: JobRunSummary['status']): JobRunSummary {
	return {
		id,
		job_id: 1,
		status,
		trigger: 'manual',
		queued_at: Date.now(),
		started_at: null,
		finished_at: null,
		error: null,
		planning_state: null,
		model_id: null,
		model_thinking: null,
		model_effort: null,
		context_size: null
	};
}

beforeEach(() => {
	state.order = [];
	state.runningId = 91;
	state.runs = [run(92, 'queued'), run(91, 'running')];
});

/** Press the dialog's confirm button (the rows have delete buttons of their own). */
async function confirm() {
	const dialog = await screen.findByRole('dialog');
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
}

const mount = () => render(JobRunHistory, { jobId: 1, selectedRunId: null, onselect: vi.fn() });

describe('JobRunHistory', () => {
	it('removes a queued run from the queue before deleting its row', async () => {
		mount();
		await fireEvent.click(screen.getByLabelText('Remove from queue'));
		await confirm();
		await waitFor(() => expect(state.order).toEqual(['unqueue 92', 'delete 92']));
	});

	it('will not delete the run in progress, or clear the history under it', () => {
		mount();
		const del = screen.getByTitle(/in progress — cancel it first/) as HTMLButtonElement;
		expect(del.disabled).toBe(true);
		expect((screen.getByText('Clear all') as HTMLButtonElement).disabled).toBe(true);
	});

	it('clears a finished history, taking the job’s queued runs out first', async () => {
		state.runningId = null;
		state.runs = [run(90, 'succeeded'), run(93, 'queued')];
		mount();
		await fireEvent.click(screen.getByText('Clear all'));
		await confirm();
		await waitFor(() => expect(state.order).toEqual(['unqueue job', 'delete all']));
	});
});
