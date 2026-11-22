/**
 * Research by email on arrival: keeps Rust's inbox watchers
 * (`email_watch_set`) in step with the jobs that pick up on arrival, and runs
 * a job when its watcher sees a request come in.
 *
 * A hit is only a hint: the run scans, checks Sent and claims as it always
 * does. Two things a single run can miss are covered by follow-up runs at
 * [`FOLLOW_UPS_MS`] after a hit:
 * - a request whose copy reaches Sent after it reaches the Inbox (a Sent
 *   copy landing wakes no IDLE on the Inbox), and
 * - a hit while the job was already running, whose scan may have been too
 *   early to see it.
 * Each follow-up runs the job only while one of those holds, and the first
 * that finds neither ends them. The job's schedule stays the backup check.
 *
 * The main window calls `startEmailWatch` once and `syncEmailWatch` on every
 * settings or jobs change; only a change is pushed to Rust.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getJob, isJobsLoaded, loadJobs, type JobSummary } from '#lib/stores/jobs.svelte.ts';
import type { EmailAccount } from '#lib/stores/settings.ts';
import { openEmailRequests } from '#lib/stores/emailRequests.ts';
import { enqueue, getActiveRunForJob, getPendingQueue } from '#lib/agent/jobs/runner.svelte.ts';
import {
	parseEmailResearchConfig,
	type EmailResearchConfig
} from '#lib/agent/jobs/types/email-research/config.ts';
import type { EmailWatchEntry } from '#lib/ipc/gen/EmailWatchEntry.ts';
import type { EmailWatchHit } from '#lib/ipc/gen/EmailWatchHit.ts';
import type { EmailWatchState } from '#lib/ipc/gen/EmailWatchState.ts';
import type { EmailWatchStatus } from '#lib/ipc/gen/EmailWatchStatus.ts';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';

/** When follow-up runs may start, counted from the hit. */
export const FOLLOW_UPS_MS = [2, 5, 15, 30].map((m) => m * 60_000);

/** Job id → its watcher's state, as Rust last reported it. */
let states = $state<Record<number, EmailWatchState>>({});

/** What the job's inbox watcher is doing, or null when it has none. */
export function emailWatchState(jobId: number): EmailWatchState | null {
	return states[jobId] ?? null;
}

function setStates(list: EmailWatchStatus[]): void {
	states = Object.fromEntries(list.map((s) => [s.jobId, s.state]));
}

/**
 * The entries to watch: jobs that pick up on arrival, with a phrase, on an
 * account that is on and may send. One per account, the lowest job id, as a
 * run allows.
 */
export function watchEntries(
	jobs: { id: number; config: EmailResearchConfig }[],
	accounts: EmailAccount[]
): EmailWatchEntry[] {
	const out: EmailWatchEntry[] = [];
	for (const { id, config } of [...jobs].sort((a, b) => a.id - b.id)) {
		if (config.pickup !== 'arrival' || !config.phrase.trim()) continue;
		const account = accounts.find((a) => a.id === config.accountId);
		if (!account || !account.enabled || !account.sendEnabled) continue;
		if (out.some((e) => e.account.id === account.id)) continue;
		out.push({ jobId: id, account, phrase: config.phrase.trim() });
	}
	return out;
}

/** Job id → its config, read once per save (`updated_at`). A cache, not UI state. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const configs = new Map<number, { updatedAt: number; config: EmailResearchConfig }>();
let lastKey: string | null = null;
let syncs = 0;

/** Push the watched jobs to Rust if they changed since the last push. */
export async function syncEmailWatch(jobs: JobSummary[], accounts: EmailAccount[]): Promise<void> {
	const mine = ++syncs;
	const wanted: { id: number; config: EmailResearchConfig }[] = [];
	for (const summary of jobs) {
		if (summary.job_type !== 'email_research') continue;
		let cached = configs.get(summary.id);
		if (!cached || cached.updatedAt !== summary.updated_at) {
			const job = await getJob(summary.id);
			if (!job) continue;
			cached = { updatedAt: summary.updated_at, config: parseEmailResearchConfig(job.type_config) };
			configs.set(summary.id, cached);
		}
		wanted.push({ id: summary.id, config: cached.config });
	}
	// A later call saw newer jobs or settings.
	if (mine !== syncs) return;
	const entries = watchEntries(wanted, accounts);
	// Nothing to start, and nothing started yet to stop.
	if (lastKey === null && entries.length === 0) return;
	const key = JSON.stringify(entries);
	if (key === lastKey) return;
	lastKey = key;
	try {
		setStates(await invoke<EmailWatchStatus[]>('email_watch_set', { entries }));
	} catch (e) {
		// Try again on the next change.
		if (lastKey === key) lastKey = null;
		console.warn('Email watch:', errMessage(e));
	}
}

interface FollowUps {
	timers: ReturnType<typeof setTimeout>[];
	/** A hit came while the job was busy; run once it isn't. */
	again: boolean;
}

/** Job id → its pending follow-ups. Timers, not UI state. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const followUps = new Map<number, FollowUps>();

function busy(jobId: number): boolean {
	return getActiveRunForJob(jobId) !== null || getPendingQueue().some((q) => q.jobId === jobId);
}

function endFollowUps(jobId: number): void {
	const f = followUps.get(jobId);
	if (!f) return;
	for (const t of f.timers) clearTimeout(t);
	followUps.delete(jobId);
}

async function runNow(jobId: number): Promise<void> {
	const runId = await enqueue(jobId, 'email');
	logDebug('jobs', 'email watch: request arrived', { jobId, runId });
}

/** A request candidate arrived: run the job now, or after the run it has. */
export async function onEmailWatchHit(jobId: number): Promise<void> {
	endFollowUps(jobId);
	const f: FollowUps = { timers: [], again: false };
	followUps.set(jobId, f);
	f.timers = FOLLOW_UPS_MS.map((ms, i) =>
		setTimeout(() => {
			void followUp(jobId, f, i === FOLLOW_UPS_MS.length - 1).catch((e: unknown) =>
				console.warn('Email watch follow-up:', errMessage(e))
			);
		}, ms)
	);
	if (busy(jobId)) f.again = true;
	else await runNow(jobId);
}

async function followUp(jobId: number, f: FollowUps, last: boolean): Promise<void> {
	if (followUps.get(jobId) !== f) return;
	if (last) followUps.delete(jobId);
	// Still going: the next follow-up looks again.
	if (busy(jobId)) {
		f.again = true;
		return;
	}
	const waiting = (await openEmailRequests(jobId)).some((r) => r.state === 'waiting_sent');
	if (f.again || waiting) {
		f.again = false;
		await runNow(jobId);
	} else {
		endFollowUps(jobId);
	}
}

let started = false;

/** Listen for the watchers' hits and states. Main window only, once. */
export function startEmailWatch(): void {
	if (started) return;
	started = true;
	if (!isJobsLoaded()) void loadJobs();
	void listen<EmailWatchHit>('email://watch-hit', (e) => {
		void onEmailWatchHit(e.payload.jobId).catch((err: unknown) =>
			console.warn('Email watch:', errMessage(err))
		);
	}).catch((e: unknown) => console.warn('Email watch: listening failed', errMessage(e)));
	void listen<EmailWatchStatus[]>('email://watch-status', (e) => setStates(e.payload)).catch(
		(e: unknown) => console.warn('Email watch: listening failed', errMessage(e))
	);
}

/** For tests. */
export function _resetEmailWatchForTests(): void {
	for (const id of [...followUps.keys()]) endFollowUps(id);
	configs.clear();
	lastKey = null;
	syncs = 0;
	states = {};
	started = false;
}
