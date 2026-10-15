import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import JobList from './JobList.svelte';

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

const job = {
	id: 7,
	name: 'Hangman plan',
	description: null,
	job_type: 'guided_planning',
	schedule_kind: 'manual',
	schedule_config: null,
	step_count: 0,
	created_at: 1,
	updated_at: 1,
	parent_job_id: null as number | null,
	parent_run_id: null as number | null
};

/** What the planning job's run 3 started: assets, which started coding. */
const assets = {
	...job,
	id: 8,
	name: 'Hangman plan — assets',
	created_at: 2,
	updated_at: 2,
	parent_job_id: 7,
	parent_run_id: 3
};
const coding = {
	...job,
	id: 9,
	name: 'Hangman plan — coding',
	created_at: 3,
	updated_at: 3,
	parent_job_id: 8,
	parent_run_id: 4
};
const headlines = { ...job, id: 10, name: 'Morning headlines', description: 'news' };

const store = vi.hoisted(() => ({ jobs: [] as unknown[] }));

vi.mock('#lib/stores/jobs.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/jobs.svelte.ts')>()),
	getJobs: () => store.jobs
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
	store.jobs = [job];
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

	describe('jobs a run started', () => {
		beforeEach(() => {
			store.jobs = [job, assets, coding, headlines];
		});

		const names = () =>
			[...document.querySelectorAll('.row .name')].map((n) => n.firstChild?.textContent?.trim());

		it('nests them under the job that started them, closed', async () => {
			render(JobList, { selectedId: null, onselect: vi.fn(), onrun: vi.fn() });
			expect(screen.queryByText('Hangman plan — assets')).toBeNull();
			expect(screen.getByText(/2 started/)).toBeTruthy();

			await fireEvent.click(screen.getByLabelText('Show the jobs it started'));
			expect(screen.getByText('Hangman plan — assets')).toBeTruthy();
			// The asset job's own coding job stays closed under it.
			expect(screen.queryByText('Hangman plan — coding')).toBeNull();
		});

		it('opens the way down to a selected job', () => {
			render(JobList, { selectedId: 9, onselect: vi.fn(), onrun: vi.fn() });
			expect(screen.getByText('Hangman plan — coding')).toBeTruthy();
		});

		it('marks a closed parent when a job below it is running', () => {
			runner.current = { jobId: 9, jobName: 'Hangman plan — coding', status: 'running' };
			// A fresh parent id: open state is shared across mounts.
			store.jobs = [
				{ ...job, id: 70 },
				{ ...assets, id: 80, parent_job_id: 70 },
				{ ...coding, parent_job_id: 80 }
			];
			render(JobList, { selectedId: null, onselect: vi.fn(), onrun: vi.fn() });
			expect(screen.getByLabelText('A job it started is running')).toBeTruthy();
		});

		it('filters by name and keeps the jobs above a match', async () => {
			render(JobList, { selectedId: null, onselect: vi.fn(), onrun: vi.fn() });
			await fireEvent.input(screen.getByLabelText('Filter jobs'), {
				target: { value: 'coding' }
			});
			expect(screen.getByText('Hangman plan — coding')).toBeTruthy();
			expect(screen.queryByText('Morning headlines')).toBeNull();
			expect(names()).toHaveLength(3);
		});

		it('filters by description, and Escape clears it', async () => {
			render(JobList, { selectedId: null, onselect: vi.fn(), onrun: vi.fn() });
			const input = screen.getByLabelText('Filter jobs');
			await fireEvent.input(input, { target: { value: 'news' } });
			expect(names()).toHaveLength(1);
			await fireEvent.keyDown(input, { key: 'Escape' });
			expect(screen.getByText('Morning headlines')).toBeTruthy();
			expect(names().length).toBeGreaterThan(1);
		});

		it('says so when nothing matches', async () => {
			render(JobList, { selectedId: null, onselect: vi.fn(), onrun: vi.fn() });
			await fireEvent.input(screen.getByLabelText('Filter jobs'), {
				target: { value: 'zzz' }
			});
			expect(screen.getByText('No jobs match.')).toBeTruthy();
		});
	});

	it('has a handle to resize the list', () => {
		render(JobList, { selectedId: null, onselect: vi.fn(), onrun: vi.fn() });
		expect(screen.getByLabelText('Drag to resize')).toBeTruthy();
	});
});
