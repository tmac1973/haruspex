import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({
	enqueue: vi.fn<(jobId: number, trigger: string) => Promise<number | null>>(async () => 1),
	currentRun: null as { status: string } | null,
	// Signatures matter here: a bare `vi.fn()` types its calls as [], and the
	// assertions read back the job input the editor saved.
	updateJob: vi.fn<(id: number, input: { name: string }) => Promise<boolean>>(async () => true),
	replaceJobSteps: vi.fn<(jobId: number, steps: unknown[]) => Promise<boolean>>(async () => true)
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

vi.mock('$lib/agent/jobs/runner.svelte', () => ({
	enqueue: mocks.enqueue,
	getCurrentRun: () => mocks.currentRun,
	getQueueDepth: () => 0
}));

const savedJob = {
	id: 7,
	name: 'Hangman plan',
	description: null,
	working_dir: '/home/tim/projects/hangman',
	job_type: 'research',
	schedule_kind: 'manual',
	schedule_config: null,
	type_config: null,
	model_advanced: null,
	model_remote_base_url: null,
	model_remote_api_key: null,
	model_remote_api_key_id: null,
	model_remote_model_id: null,
	model_remote_context_size: null,
	model_remote_vision_supported: null,
	step_count: 1,
	steps: [{ prompt: 'Summarize the news', deep_research: false }]
};

vi.mock('$lib/stores/jobs.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/stores/jobs.svelte')>();
	return {
		...actual,
		getJobs: () => [savedJob, { ...savedJob, id: 8, name: 'Other job' }],
		isJobsLoaded: () => true,
		loadJobs: vi.fn(),
		getJob: vi.fn(async () => savedJob),
		updateJob: mocks.updateJob,
		replaceJobSteps: mocks.replaceJobSteps,
		createJob: vi.fn(async () => 9),
		deleteJob: vi.fn(async () => true)
	};
});

import JobsTab from './JobsTab.svelte';

/** Open job 7 in the editor and type into its name field, leaving it dirty. */
async function openAndEdit() {
	render(JobsTab);
	await fireEvent.click(screen.getByText('Hangman plan'));
	const nameInput = await screen.findByDisplayValue('Hangman plan');
	// The baseline is captured a tick after load; edit once it exists.
	await waitFor(() => expect(nameInput).toBeTruthy());
	await fireEvent.input(nameInput, { target: { value: 'Hangman plan v2' } });
	return nameInput;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.currentRun = null;
	mocks.enqueue.mockResolvedValue(1);
});

/**
 * Editor state lives in the component until Save writes it to the DB, and the
 * run path reads the DB — so clicking a job's run arrow mid-edit silently ran
 * the version the user thought they had just changed.
 */
describe('JobsTab — running a job with unsaved edits', () => {
	it('prompts instead of running the stored version', async () => {
		await openAndEdit();

		await fireEvent.click(screen.getAllByTitle('Run now')[0]);

		expect(await screen.findByText('Unsaved changes')).toBeTruthy();
		expect(mocks.enqueue).not.toHaveBeenCalled();
	});

	it('saves first when asked, then runs', async () => {
		await openAndEdit();
		await fireEvent.click(screen.getAllByTitle('Run now')[0]);

		await fireEvent.click(await screen.findByText('Save, then run'));

		await waitFor(() => expect(mocks.updateJob).toHaveBeenCalled());
		// The edit reached the DB before the run was queued.
		expect(mocks.updateJob.mock.calls[0][1].name).toBe('Hangman plan v2');
		await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledWith(7, 'manual'));
	});

	it('runs the stored version when that is what the user picks', async () => {
		await openAndEdit();
		await fireEvent.click(screen.getAllByTitle('Run now')[0]);

		await fireEvent.click(await screen.findByText('Run saved version'));

		await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledWith(7, 'manual'));
		expect(mocks.updateJob).not.toHaveBeenCalled();
	});

	it('does nothing at all on Cancel', async () => {
		await openAndEdit();
		await fireEvent.click(screen.getAllByTitle('Run now')[0]);

		// The editor has a Cancel button of its own — scope to the dialog.
		const dialog = await screen.findByRole('dialog');
		await fireEvent.click(within(dialog).getByText('Cancel'));

		expect(mocks.enqueue).not.toHaveBeenCalled();
		expect(mocks.updateJob).not.toHaveBeenCalled();
		// Still editing, edits intact.
		expect(screen.getByDisplayValue('Hangman plan v2')).toBeTruthy();
	});

	it('runs straight away when there is nothing unsaved', async () => {
		render(JobsTab);
		await fireEvent.click(screen.getByText('Hangman plan'));
		await screen.findByDisplayValue('Hangman plan');

		await fireEvent.click(screen.getAllByTitle('Run now')[0]);

		await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledWith(7, 'manual'));
		expect(screen.queryByText('Unsaved changes')).toBeNull();
	});
});

describe('JobsTab — switching jobs with unsaved edits', () => {
	it('prompts rather than dropping the edits silently', async () => {
		await openAndEdit();

		await fireEvent.click(screen.getByText('Other job'));

		expect(await screen.findByText('Unsaved changes')).toBeTruthy();
		// Still on the job being edited.
		expect(screen.getByDisplayValue('Hangman plan v2')).toBeTruthy();
	});

	it('switches after saving when asked', async () => {
		await openAndEdit();
		await fireEvent.click(screen.getByText('Other job'));

		await fireEvent.click(await screen.findByText('Save and switch'));

		await waitFor(() => expect(mocks.updateJob).toHaveBeenCalled());
		expect(mocks.updateJob.mock.calls[0][1].name).toBe('Hangman plan v2');
	});

	it('discards the edits when the user says so', async () => {
		await openAndEdit();
		await fireEvent.click(screen.getByText('Other job'));

		await fireEvent.click(await screen.findByText('Switch without saving'));

		await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
		expect(mocks.updateJob).not.toHaveBeenCalled();
	});
});

/**
 * The run view owns the centre pane while a run is live, so a selection made
 * during one highlighted a row and changed nothing the user could see.
 */
describe('JobsTab — while a run owns the pane', () => {
	it('locks the job list', async () => {
		mocks.currentRun = { status: 'running' };
		render(JobsTab);

		const row = screen.getByText('Hangman plan').closest('.row')!;
		expect(row.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(row);
		// No editor opened behind the run view.
		expect(screen.queryByDisplayValue('Hangman plan')).toBeNull();
	});
});

/**
 * A scheduled fire of an interactive type parks the run on its first question
 * with nobody there to answer it, holding the runner. Those types have no
 * schedule at all, so the field is hidden rather than disabled.
 */
describe('JobsTab — schedules on types that interview the user', () => {
	/** The schedule lives in the collapsed "Where & when" section. */
	async function openWhereSection() {
		await fireEvent.click(await screen.findByText('Where & when'));
	}

	it('offers a schedule for a research job', async () => {
		render(JobsTab);
		await fireEvent.click(screen.getByText('Hangman plan'));
		await screen.findByDisplayValue('Hangman plan');
		await openWhereSection();

		expect(screen.getByText('Schedule')).toBeTruthy();
	});

	it('hides it for guided planning, and says why', async () => {
		render(JobsTab);
		await fireEvent.click(screen.getByRole('button', { name: '+ New' }));
		await openWhereSection();
		expect(screen.getByText('Schedule')).toBeTruthy();

		const typeSelect = screen.getByRole('combobox', { name: /job type/i });
		await fireEvent.change(typeSelect, { target: { value: 'guided_planning' } });

		await waitFor(() => expect(screen.queryByText('Schedule')).toBeNull());
		expect(screen.getByText(/only run when you start them/)).toBeTruthy();
	});
});
