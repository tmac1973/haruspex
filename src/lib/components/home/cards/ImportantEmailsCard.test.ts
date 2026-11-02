import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
import type { LatestRun } from '#lib/home/latestRun.svelte.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

const m = vi.hoisted(() => ({
	latest: { latest: null, latestSucceeded: null } as LatestRun,
	current: null as Record<string, unknown> | null,
	enqueue: vi.fn(async () => 1)
}));

vi.mock('#lib/home/latestRun.svelte.ts', () => ({ getLatestRun: () => m.latest }));
vi.mock('#lib/agent/jobs/runner.svelte.ts', () => ({
	enqueue: m.enqueue,
	getCurrentRun: () => m.current,
	getPendingQueue: () => []
}));

import ImportantEmailsCard from './ImportantEmailsCard.svelte';

const card = {
	id: 'c1',
	card_type: 'important_emails',
	job_id: 3,
	position: 0,
	size: 'normal',
	config: '{}',
	notify: false,
	last_result: null,
	updated_at: null,
	created_at: 0
} as HomeCard;

function succeeded(items: unknown[]): LatestRun['latestSucceeded'] {
	return {
		id: 5,
		status: 'succeeded',
		result_json: JSON.stringify({ items }),
		steps: []
	} as unknown as LatestRun['latestSucceeded'];
}

beforeEach(() => {
	m.latest = { latest: null, latestSucceeded: null };
	m.current = null;
	m.enqueue.mockClear();
});

describe('ImportantEmailsCard', () => {
	it('shows each picked message from its source, with the model’s reason', () => {
		const run = succeeded([
			{
				id: 'w|1',
				why: 'Money owed',
				source: { from: 'Dana <dana@example.com>', subject: 'Invoice overdue', date: '' }
			}
		]);
		m.latest = { latest: run, latestSucceeded: run };
		render(ImportantEmailsCard, { card });
		expect(screen.getByText('Invoice overdue')).toBeTruthy();
		expect(screen.getByText('Dana <dana@example.com>')).toBeTruthy();
		expect(screen.getByText('Money owed')).toBeTruthy();
	});

	it('says so when nothing is important, and when it has not checked yet', () => {
		const run = succeeded([]);
		m.latest = { latest: run, latestSucceeded: run };
		const { unmount } = render(ImportantEmailsCard, { card });
		expect(screen.getByText('No important mail.')).toBeTruthy();
		unmount();

		m.latest = { latest: null, latestSucceeded: null };
		render(ImportantEmailsCard, { card });
		expect(screen.getByText('Not checked yet.')).toBeTruthy();
	});

	it('puts a failed check’s error above the last good result', () => {
		const good = succeeded([]);
		m.latest = {
			latest: { id: 6, status: 'failed', error: 'IMAP login failed' } as LatestRun['latest'],
			latestSucceeded: good
		};
		render(ImportantEmailsCard, { card });
		expect(screen.getByText(/The last check failed: IMAP login failed/)).toBeTruthy();
		expect(screen.getByText('No important mail.')).toBeTruthy();
	});

	it('says it is waiting for chat, and greys out Refresh, while its run waits', () => {
		m.current = { id: 7, jobId: 3, status: 'running', waitingForSlot: true };
		render(ImportantEmailsCard, { card });
		expect(screen.getByText('Waiting for chat…')).toBeTruthy();
		expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(
			true
		);
	});

	it('checks now on Refresh', async () => {
		render(ImportantEmailsCard, { card });
		await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(m.enqueue).toHaveBeenCalledWith(3, 'manual');
	});
});
