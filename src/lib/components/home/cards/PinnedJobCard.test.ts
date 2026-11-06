import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
import type { LatestRun } from '#lib/home/latestRun.svelte.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
// jsdom has none; the card measures its output to decide on Show more.
vi.stubGlobal(
	'ResizeObserver',
	class {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
);

const m = vi.hoisted(() => ({
	latest: { latest: null, latestSucceeded: null } as LatestRun,
	current: null as Record<string, unknown> | null,
	queue: [] as { jobId: number }[],
	enqueue: vi.fn(async () => 1),
	selectJob: vi.fn(),
	setActiveTab: vi.fn()
}));

vi.mock('#lib/home/latestRun.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/home/latestRun.svelte.ts')>()),
	getLatestRun: () => m.latest
}));
vi.mock('#lib/agent/jobs/runner.svelte.ts', () => ({
	enqueue: m.enqueue,
	getActiveRuns: () =>
		m.current && ['running', 'needs_input'].includes(m.current.status as string) ? [m.current] : [],
	getActiveRunForJob: (jobId: number) =>
		m.current?.jobId === jobId && ['running', 'needs_input'].includes(m.current.status as string)
			? m.current
			: null,
	getPendingQueue: () => m.queue
}));
vi.mock('#lib/stores/jobsTabSelection.svelte.ts', () => ({ selectJob: m.selectJob }));
vi.mock('#lib/stores/activeTab.svelte.ts', () => ({ setActiveTab: m.setActiveTab }));

import PinnedJobCard from './PinnedJobCard.svelte';

function card(jobId: number | null): HomeCard {
	return {
		id: 'c1',
		card_type: 'pinned_job',
		job_id: jobId,
		position: 0,
		size: 'normal',
		config: '{}',
		notify: false,
		last_result: null,
		updated_at: null,
		created_at: 0
	};
}

function run(id: number, status: string, error: string | null = null) {
	return { id, job_id: 7, status, error } as LatestRun['latest'] & object;
}

beforeEach(() => {
	m.latest = { latest: null, latestSucceeded: null };
	m.current = null;
	m.queue = [];
	vi.clearAllMocks();
});

describe('PinnedJobCard', () => {
	it('shows the latest successful output, and opens that run', async () => {
		m.latest = {
			latest: run(5, 'succeeded'),
			latestSucceeded: { ...run(5, 'succeeded'), steps: [{ output: 'Three new papers.' }] } as never
		};
		render(PinnedJobCard, { card: card(7) });
		screen.getByText('Three new papers.');

		await fireEvent.click(screen.getByRole('button', { name: 'Open' }));
		expect(m.selectJob).toHaveBeenCalledWith(7, 5);
		expect(m.setActiveTab).toHaveBeenCalledWith('jobs');
	});

	it('puts a failed run’s error above the last good output', () => {
		m.latest = {
			latest: run(6, 'failed', 'model timed out'),
			latestSucceeded: { ...run(5, 'succeeded'), steps: [{ output: 'Old news.' }] } as never
		};
		render(PinnedJobCard, { card: card(7) });
		screen.getByText(/The last run failed: model timed out/);
		screen.getByText('Old news.');
	});

	it('runs the job, and greys Run now out while it is queued', async () => {
		const { unmount } = render(PinnedJobCard, { card: card(7) });
		screen.getByText('No runs yet.');
		await fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
		expect(m.enqueue).toHaveBeenCalledWith(7, 'manual');
		unmount();

		m.queue = [{ jobId: 7 }];
		render(PinnedJobCard, { card: card(7) });
		expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(
			true
		);
		screen.getByText('Queued');
	});

	it('says so when the job is running', () => {
		m.current = {
			id: 9,
			jobId: 7,
			status: 'running',
			steps: [{ promptAuthored: 'p', description: null, checklist: null }],
			currentStepIndex: 0,
			waitingForSlot: false
		};
		render(PinnedJobCard, { card: card(7) });
		screen.getByText('Running');
		expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(
			true
		);
	});

	it('says the job was deleted, with no buttons', () => {
		render(PinnedJobCard, { card: card(null) });
		screen.getByText('This job was deleted.');
		expect(screen.queryByRole('button')).toBeNull();
	});
});
