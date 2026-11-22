import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
import type { LatestRun } from '#lib/home/latestRun.svelte.ts';
import type { EmailRequestRow } from '#lib/stores/emailRequests.ts';

const m = vi.hoisted(() => ({
	latest: { latest: null, latestSucceeded: null } as LatestRun,
	sendEnabled: true,
	selectJob: vi.fn(),
	setActiveTab: vi.fn()
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({
			integrations: {
				email: {
					accounts: [
						{
							id: 'acc',
							label: 'Me',
							enabled: true,
							sendEnabled: m.sendEnabled,
							emailAddress: 'me@example.com'
						}
					]
				}
			}
		})
	})
);
vi.mock('#lib/home/latestRun.svelte.ts', () => ({ getLatestRun: () => m.latest }));
vi.mock('#lib/agent/jobs/runner.svelte.ts', () => ({
	getActiveRunForJob: () => null,
	getPendingQueue: () => []
}));
vi.mock('#lib/stores/jobsTabSelection.svelte.ts', () => ({ selectJob: m.selectJob }));
vi.mock('#lib/stores/activeTab.svelte.ts', async (orig) => ({
	...(await orig<object>()),
	setActiveTab: m.setActiveTab
}));

import EmailRequestsCard from './EmailRequestsCard.svelte';

const card = {
	id: 'c1',
	card_type: 'email_requests',
	job_id: 3,
	position: 0,
	size: 'normal',
	config: '{}',
	notify: false,
	last_result: null,
	updated_at: null,
	created_at: 0
} as HomeCard;

let n = 0;
function row(state: string, over: Partial<EmailRequestRow> = {}): EmailRequestRow {
	n++;
	return {
		id: n,
		jobId: 3,
		messageId: `m${n}@x`,
		threadId: `m${n}@x`,
		references: [],
		subject: `Ask Haruspex: topic ${n}`,
		question: null,
		answer: null,
		replyKind: null,
		state,
		reason: null,
		auth: { dkim: 'pass', spf: 'pass', dmarc: 'none' },
		replyMessageId: null,
		attempts: 0,
		sendAttempts: 0,
		firstSeenAt: Date.now(),
		claimedAt: null,
		updatedAt: Date.now(),
		runId: 11,
		...over
	};
}

function serve(rows: EmailRequestRow[]) {
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			db_get_job: {
				id: 3,
				type_config: JSON.stringify({ accountId: 'acc', phrase: 'ask haruspex', dailyLimit: 10 })
			},
			db_email_requests_list: () => rows
		})
	);
}

beforeEach(() => {
	n = 0;
	m.sendEnabled = true;
	m.latest = { latest: null, latestSucceeded: null };
	m.selectJob.mockClear();
	m.setActiveTab.mockClear();
	vi.mocked(invoke).mockReset();
});

describe('EmailRequestsCard', () => {
	it('shows the setup line, and only it when there are no requests', async () => {
		serve([]);
		render(EmailRequestsCard, { card });
		await screen.findByText('Email me@example.com with “ask haruspex” in the subject.');
		await screen.findByText('No requests yet.');
		expect(screen.queryByRole('listitem')).toBeNull();
	});

	it('gives each of the six states its chip, and ignored and failed their reason', async () => {
		serve([
			row('waiting_sent'),
			row('researching'),
			row('sending'),
			row('answered'),
			row('failed', { reason: 'send_failed' }),
			row('ignored', { reason: 'no_sent_copy' })
		]);
		render(EmailRequestsCard, { card });
		for (const chip of ['Waiting', 'Researching', 'Sending', 'Answered', 'Failed', 'Ignored']) {
			await screen.findByText(chip);
		}
		screen.getByText("Couldn't send");
		screen.getByText('No copy in Sent');
		// The phrase is taken out of the subject.
		screen.getByText('topic 1');
		expect(screen.getAllByText('DKIM pass · SPF pass · DMARC none')).toHaveLength(6);
	});

	it('expands an answered request to its question and answer, and opens its run', async () => {
		serve([row('answered', { question: 'Which e-bike?', answer: 'Brand **X**.' })]);
		render(EmailRequestsCard, { card });
		const button = await screen.findByRole('button', { name: /topic 1/ });
		await fireEvent.click(button);
		screen.getByText('Which e-bike?');
		await screen.findByText('X');
		await fireEvent.click(screen.getByRole('button', { name: 'Open run' }));
		expect(m.selectJob).toHaveBeenCalledWith(3, 11);
		expect(m.setActiveTab).toHaveBeenCalledWith('jobs');
	});

	it('does not expand a request that has no answer', async () => {
		serve([row('ignored', { reason: 'daily_limit', question: 'secret' })]);
		render(EmailRequestsCard, { card });
		const button = await screen.findByRole('button', { name: /topic 1/ });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		screen.getByText('Daily limit');
	});

	it('is greyed out with the reason when the account can’t send', async () => {
		m.sendEnabled = false;
		serve([]);
		const { container } = render(EmailRequestsCard, { card });
		await screen.findByText('No requests yet.');
		const body = container.querySelector('.body') as HTMLElement;
		await vi.waitFor(() => expect(body.classList.contains('off')).toBe(true));
		expect(body.title).toMatch(/Allow sending is off for Me/);
	});
});
