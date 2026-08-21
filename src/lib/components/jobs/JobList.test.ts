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

vi.mock('$lib/stores/jobs.svelte', () => ({
	getJobs: () => [job]
}));

vi.mock('$lib/agent/jobs/runner.svelte', () => ({
	getCurrentRun: () => null,
	getQueueDepth: () => 0
}));

vi.mock('$lib/agent/jobs/types', () => ({
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
});

describe('JobList', () => {
	it('selects a job when its row is clicked', async () => {
		const onselect = vi.fn();
		render(JobList, { selectedId: null, onselect, onrun: vi.fn() });

		await fireEvent.click(screen.getByText('Hangman plan'));
		expect(onselect).toHaveBeenCalledWith(7);
	});

	/**
	 * The run view owns the centre pane while a run is live, so a selection
	 * made during one highlighted a row and changed nothing visible — the
	 * user's click appeared to do nothing at all.
	 */
	describe('while a run owns the pane', () => {
		it('ignores row clicks and keyboard activation', async () => {
			const onselect = vi.fn();
			render(JobList, { selectedId: null, locked: true, onselect, onrun: vi.fn() });

			const row = screen.getByText('Hangman plan').closest('.row')!;
			await fireEvent.click(row);
			await fireEvent.keyDown(row, { key: 'Enter' });
			expect(onselect).not.toHaveBeenCalled();
		});

		it('says why, and takes the row out of the tab order', () => {
			render(JobList, { selectedId: null, locked: true, onselect: vi.fn(), onrun: vi.fn() });

			const row = screen.getByText('Hangman plan').closest('.row')!;
			expect(row.getAttribute('aria-disabled')).toBe('true');
			expect(row.getAttribute('tabindex')).toBe('-1');
			expect(row.getAttribute('title')).toMatch(/run is in progress/i);
		});

		it('disables New, which would also open an invisible editor', () => {
			render(JobList, { selectedId: null, locked: true, onselect: vi.fn(), onrun: vi.fn() });
			expect((screen.getByText('+ New') as HTMLButtonElement).disabled).toBe(true);
		});

		it('still lets a run be queued behind the active one', async () => {
			// Queueing has visible feedback (the queue badge) and is a real
			// action, so it is deliberately not part of the lock.
			const onrun = vi.fn();
			render(JobList, { selectedId: null, locked: true, onselect: vi.fn(), onrun });

			await fireEvent.click(screen.getByTitle('Run now'));
			expect(onrun).toHaveBeenCalledWith(7);
		});
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
