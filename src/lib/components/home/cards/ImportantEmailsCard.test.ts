import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
import type { LatestRun } from '#lib/home/latestRun.svelte.ts';

const m = vi.hoisted(() => ({
	latest: { latest: null, latestSucceeded: null } as LatestRun,
	current: null as Record<string, unknown> | null,
	enqueue: vi.fn(async () => 1)
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({
			integrations: { email: { accounts: [{ id: 'acc', label: 'Work', sendEnabled: false }] } }
		})
	})
);
vi.mock('#lib/home/latestRun.svelte.ts', () => ({ getLatestRun: () => m.latest }));
vi.mock('#lib/agent/jobs/runner.svelte.ts', () => ({
	enqueue: m.enqueue,
	getActiveRuns: () =>
		m.current && ['running', 'needs_input'].includes(m.current.status as string) ? [m.current] : [],
	getActiveRunForJob: (jobId: number) =>
		m.current?.jobId === jobId && ['running', 'needs_input'].includes(m.current.status as string)
			? m.current
			: null,
	getPendingQueue: () => []
}));

import ImportantEmailsCard from './ImportantEmailsCard.svelte';
import { _resetForTests } from '#lib/home/trashedEmails.svelte.ts';

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

function email(id: string, subject: string) {
	return {
		id,
		why: 'Money owed',
		source: { accountId: 'acc', messageId: `mid-${id}`, from: 'Dana', subject, date: '' }
	};
}

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
	vi.mocked(invoke).mockClear();
	_resetForTests();
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
		screen.getByText('Invoice overdue');
		screen.getByText('Dana <dana@example.com>');
		screen.getByText('Money owed');
	});

	it('says so when nothing is important, and when it has not checked yet', () => {
		const run = succeeded([]);
		m.latest = { latest: run, latestSucceeded: run };
		const { unmount } = render(ImportantEmailsCard, { card });
		screen.getByText('No important mail.');
		unmount();

		m.latest = { latest: null, latestSucceeded: null };
		render(ImportantEmailsCard, { card });
		screen.getByText('Not checked yet.');
	});

	it('puts a failed check’s error above the last good result', () => {
		const good = succeeded([]);
		m.latest = {
			latest: { id: 6, status: 'failed', error: 'IMAP login failed' } as LatestRun['latest'],
			latestSucceeded: good
		};
		render(ImportantEmailsCard, { card });
		screen.getByText(/The last check failed: IMAP login failed/);
		screen.getByText('No important mail.');
	});

	it('says it is waiting for chat while its run waits', () => {
		m.current = { id: 7, jobId: 3, status: 'running', waitingForSlot: true };
		render(ImportantEmailsCard, { card });
		screen.getByText('Waiting for chat…');
	});

	it('opens a message when its row is clicked', async () => {
		const run = succeeded([email('a', 'Invoice overdue')]);
		m.latest = { latest: run, latestSucceeded: run };
		render(ImportantEmailsCard, { card });
		await fireEvent.click(screen.getByRole('button', { name: 'Open Invoice overdue' }));
		await screen.findByText('Reading…');
	});

	it('moves a message to Trash after asking, and stops listing it', async () => {
		m.latest = { latest: null, latestSucceeded: succeeded([email('a', 'Invoice overdue')]) };
		render(ImportantEmailsCard, { card });
		await fireEvent.click(screen.getByRole('button', { name: 'Actions for Invoice overdue' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
		await waitFor(() => expect(screen.queryByText('Invoice overdue')).toBeNull());
		expect(invoke).toHaveBeenCalledWith('email_trash', {
			account: expect.objectContaining({ id: 'acc' }),
			messageId: 'mid-a'
		});
	});
});
