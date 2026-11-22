import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EmailAccount } from '#lib/stores/settings.ts';
import type { JobSummary } from '#lib/stores/jobs.svelte.ts';
import type { EmailResearchConfig } from './config';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	listen: vi.fn(),
	getJob: vi.fn(),
	enqueue: vi.fn(),
	active: new Set<number>(),
	queued: new Set<number>(),
	open: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('#lib/stores/jobs.svelte.ts', () => ({
	getJob: mocks.getJob,
	isJobsLoaded: () => true,
	loadJobs: vi.fn()
}));
vi.mock('#lib/stores/emailRequests.ts', () => ({ openEmailRequests: mocks.open }));
vi.mock('#lib/agent/jobs/runner.svelte.ts', () => ({
	enqueue: mocks.enqueue,
	getActiveRunForJob: (id: number) => (mocks.active.has(id) ? { jobId: id } : null),
	getPendingQueue: () => [...mocks.queued].map((jobId) => ({ jobId }))
}));

import {
	FOLLOW_UPS_MS,
	_resetEmailWatchForTests,
	emailWatchState,
	onEmailWatchHit,
	syncEmailWatch,
	watchEntries
} from './watch.svelte';

function account(over: Partial<EmailAccount> = {}): EmailAccount {
	return {
		id: 'a1',
		label: 'Me',
		enabled: true,
		sendEnabled: true,
		emailAddress: 'me@example.com',
		...over
	} as EmailAccount;
}

function config(over: Partial<EmailResearchConfig> = {}): EmailResearchConfig {
	return { accountId: 'a1', phrase: 'ask haruspex', dailyLimit: 10, pickup: 'arrival', ...over };
}

function summary(id: number, updatedAt = 1): JobSummary {
	return { id, job_type: 'email_research', updated_at: updatedAt } as JobSummary;
}

beforeEach(() => {
	_resetEmailWatchForTests();
	mocks.invoke.mockReset().mockResolvedValue([]);
	mocks.getJob.mockReset();
	mocks.enqueue.mockReset().mockResolvedValue(10);
	mocks.open.mockReset().mockResolvedValue([]);
	mocks.active.clear();
	mocks.queued.clear();
});

describe('watchEntries', () => {
	it('watches arrival jobs on accounts that are on and may send, one per account', () => {
		const accounts = [
			account(),
			account({ id: 'off', enabled: false }),
			account({ id: 'nosend', sendEnabled: false })
		];
		const jobs = [
			{ id: 3, config: config() },
			{ id: 2, config: config({ phrase: '  ask haruspex  ' }) },
			{ id: 4, config: config({ accountId: 'off' }) },
			{ id: 5, config: config({ accountId: 'nosend' }) },
			{ id: 6, config: config({ accountId: 'gone' }) },
			{ id: 7, config: config({ accountId: 'a1', pickup: 'schedule' }) }
		];
		const entries = watchEntries(jobs, accounts);
		expect(entries).toEqual([{ jobId: 2, account: accounts[0], phrase: 'ask haruspex' }]);
	});
});

describe('syncEmailWatch', () => {
	it('pushes only a change, and reads a job again only after it is saved', async () => {
		mocks.getJob.mockResolvedValue({ id: 1, type_config: JSON.stringify(config()) });
		mocks.invoke.mockResolvedValue([{ jobId: 1, state: { state: 'idle' } }]);
		await syncEmailWatch([summary(1)], [account()]);
		await syncEmailWatch([summary(1)], [account()]);
		expect(mocks.invoke).toHaveBeenCalledTimes(1);
		expect(mocks.invoke).toHaveBeenCalledWith('email_watch_set', {
			entries: [{ jobId: 1, account: account(), phrase: 'ask haruspex' }]
		});
		expect(mocks.getJob).toHaveBeenCalledTimes(1);
		expect(emailWatchState(1)).toEqual({ state: 'idle' });

		// Saved with pickup off: the watcher is stopped.
		mocks.getJob.mockResolvedValue({
			id: 1,
			type_config: JSON.stringify(config({ pickup: 'schedule' }))
		});
		mocks.invoke.mockResolvedValue([]);
		await syncEmailWatch([summary(1, 2)], [account()]);
		expect(mocks.invoke).toHaveBeenLastCalledWith('email_watch_set', { entries: [] });
		expect(emailWatchState(1)).toBeNull();
	});

	it('pushes nothing while there was never anything to watch', async () => {
		await syncEmailWatch([], [account()]);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('tries again on the next change after a failed push', async () => {
		mocks.getJob.mockResolvedValue({ id: 1, type_config: JSON.stringify(config()) });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mocks.invoke.mockRejectedValueOnce(new Error('no'));
		await syncEmailWatch([summary(1)], [account()]);
		await syncEmailWatch([summary(1)], [account()]);
		expect(mocks.invoke).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});
});

describe('onEmailWatchHit', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	async function at(ms: number) {
		await vi.advanceTimersByTimeAsync(ms);
	}

	it('runs the job at once, and follows up while a request waits for its Sent copy', async () => {
		await onEmailWatchHit(1);
		expect(mocks.enqueue).toHaveBeenCalledWith(1, 'email');
		mocks.open.mockResolvedValue([{ state: 'waiting_sent' }]);
		await at(FOLLOW_UPS_MS[0]);
		expect(mocks.enqueue).toHaveBeenCalledTimes(2);
		// The copy arrived and that run claimed it: the next follow-up ends them.
		mocks.open.mockResolvedValue([{ state: 'researching' }]);
		await at(FOLLOW_UPS_MS[1] - FOLLOW_UPS_MS[0]);
		expect(mocks.enqueue).toHaveBeenCalledTimes(2);
		await at(FOLLOW_UPS_MS[3]);
		expect(mocks.enqueue).toHaveBeenCalledTimes(2);
		expect(mocks.open).toHaveBeenCalledTimes(2);
	});

	it('runs once more after the run it was busy with', async () => {
		mocks.active.add(1);
		await onEmailWatchHit(1);
		expect(mocks.enqueue).not.toHaveBeenCalled();
		// Still running at the first follow-up.
		await at(FOLLOW_UPS_MS[0]);
		expect(mocks.enqueue).not.toHaveBeenCalled();
		mocks.active.delete(1);
		await at(FOLLOW_UPS_MS[1] - FOLLOW_UPS_MS[0]);
		expect(mocks.enqueue).toHaveBeenCalledTimes(1);
		expect(mocks.enqueue).toHaveBeenCalledWith(1, 'email');
	});

	it('treats a queued run as busy too', async () => {
		mocks.queued.add(1);
		await onEmailWatchHit(1);
		expect(mocks.enqueue).not.toHaveBeenCalled();
	});

	it('starts the follow-ups again on a new hit', async () => {
		await onEmailWatchHit(1);
		await at(FOLLOW_UPS_MS[0] - 1000);
		await onEmailWatchHit(1);
		expect(mocks.enqueue).toHaveBeenCalledTimes(2);
		mocks.open.mockResolvedValue([{ state: 'waiting_sent' }]);
		// The first hit's first follow-up would have been now; it was cleared.
		await at(1000);
		expect(mocks.open).not.toHaveBeenCalled();
		await at(FOLLOW_UPS_MS[0] - 1000);
		expect(mocks.open).toHaveBeenCalledTimes(1);
		expect(mocks.enqueue).toHaveBeenCalledTimes(3);
	});
});
