import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import JobList from './JobList.svelte';

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

const job = {
	id: 7,
	name: 'Hangman plan',
	job_type: 'guided_planning',
	schedule_kind: 'manual',
	schedule_config: null,
	step_count: 0
};

vi.mock('#lib/stores/jobs.svelte.ts', () => ({
	getJobs: () => [job]
}));

const runner = vi.hoisted(() => ({
	current: null as null | { jobId: number; jobName: string; status: string },
	queue: [] as Array<{ jobName: string }>
}));

vi.mock('#lib/agent/jobs/runner.svelte.ts', () => ({
	getCurrentRun: () => runner.current,
	getQueueDepth: () => runner.queue.length,
	getPendingQueue: () => runner.queue
}));

vi.mock('#lib/agent/jobs/types/index.ts', () => ({
	ensureTypeAvailabilityLoaded: () => Promise.resolve(),
	getJobType: () => ({
		badgeLabel: 'Plan',
		badgeTone: '',
		hasPlannedSteps: false
	}),
	isJobTypeAvailable: () => true
}));

beforeEach(() => {
	vi.clearAllMocks();
	runner.current = null;
	runner.queue = [];
});

describe('JobList', () => {
	it('selects a job when its row is clicked', async () => {
		const onselect = vi.fn();
		render(JobList, { selectedId: null, onselect, onrun: vi.fn() });

		await fireEvent.click(screen.getByText('Hangman plan'));
		expect(onselect).toHaveBeenCalledWith(7);
	});

	/**
	 * A live run no longer locks the list: you browse and edit while it runs,
	 * and the run's own job is marked so you can find it.
	 */
	describe('while a run is live', () => {
		beforeEach(() => {
			runner.current = { jobId: 7, jobName: 'Hangman plan', status: 'running' };
		});

		it('still selects jobs and opens New', async () => {
			const onselect = vi.fn();
			render(JobList, { selectedId: null, onselect, onrun: vi.fn() });
			await fireEvent.click(screen.getByText('Hangman plan'));
			await fireEvent.click(screen.getByText('+ New'));
			expect(onselect).toHaveBeenCalledWith(7);
			expect(onselect).toHaveBeenCalledWith('new');
		});

		it('marks the running job', () => {
			render(JobList, { selectedId: null, onselect: vi.fn(), onrun: vi.fn() });
			const row = screen.getByText('Hangman plan').closest('.row')!;
			expect(row.querySelector('[aria-label="Running"]')).not.toBeNull();
		});

		it('says ▶ will run now or after the current run', async () => {
			const onrun = vi.fn();
			render(JobList, { selectedId: null, onselect: vi.fn(), onrun });
			await fireEvent.click(screen.getByTitle('Run now, or after the current run finishes'));
			expect(onrun).toHaveBeenCalledWith(7);
		});

		it('lists the running and queued jobs, in order, in the badge tooltip', () => {
			runner.queue = [{ jobName: 'Game — coding' }, { jobName: 'Audit' }];
			render(JobList, { selectedId: null, onselect: vi.fn(), onrun: vi.fn() });
			expect(
				screen
					.getByText(/1 running/)
					.closest('.queue-badge')!
					.getAttribute('title')
			).toBe('Running: Hangman plan\n1. Game — coding\n2. Audit');
		});
	});

	it('marks nothing when no run is live', () => {
		render(JobList, { selectedId: null, onselect: vi.fn(), onrun: vi.fn() });
		expect(document.querySelector('[aria-label="Running"]')).toBeNull();
	});

	/**
	 * The list used to call `enqueue` itself, which reads the STORED job —
	 * so running from here while the editor held unsaved edits silently ran
	 * the old version. The tab owns enqueueing now because it is the only
	 * place that knows the editor is dirty.
	 */
	it('delegates running to the tab rather than enqueueing itself', async () => {
		const onrun = vi.fn();
		const onselect = vi.fn();
		render(JobList, { selectedId: null, onselect, onrun });

		await fireEvent.click(screen.getByTitle('Run now'));
		expect(onrun).toHaveBeenCalledWith(7);
		// The row click behind the button must not also fire.
		expect(onselect).not.toHaveBeenCalled();
	});
});
