/**
 * In-app job scheduler.
 *
 * A single setInterval ticker polls the DB for jobs whose `next_due_at`
 * has passed and hands them to the runner with trigger='scheduled'.
 * After enqueue we recompute and persist the next due time, so cadence
 * stays steady even if the runner queues the work behind other runs.
 *
 * The app must be open for this to fire. A job that came due while the
 * app was closed is due at the first tick after launch, so it runs once
 * then, however many runs it missed: `computeNextDueAt` steps the next
 * due time past now. The job editor's schedule field says so.
 *
 * The 30-second tick interval is loose on purpose. Sub-minute precision
 * would add cost (queries + clock work) for no real-world benefit — the
 * user-facing schedules are minute-or-coarser.
 */

import {
	configJsonToSchedule,
	computeNextDueAt,
	listDueJobs,
	setJobNextDueAt,
	type JobSummary
} from '#lib/stores/jobs.svelte.ts';
import { enqueue } from '#lib/agent/jobs/runner.svelte.ts';
import { cardUsesExistingJob, getHomeCards, loadHomeCards } from '#lib/stores/homeCards.svelte.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { getJobType } from '#lib/agent/jobs/types/index.ts';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';

const TICK_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startScheduler(): void {
	if (timer !== null) return;
	// Fire one tick immediately so a just-due job doesn't wait the full
	// interval after app start.
	void tick();
	timer = setInterval(() => void tick(), TICK_MS);
	logDebug('jobs', 'scheduler started', { intervalMs: TICK_MS });
}

export function stopScheduler(): void {
	if (timer !== null) {
		clearInterval(timer);
		timer = null;
		logDebug('jobs', 'scheduler stopped');
	}
}

/**
 * Public for tests + manual "refresh" UX. The internal ticker calls
 * this too. Reentrancy-guarded — if a tick takes longer than the
 * interval (e.g. the DB call is slow), the next setInterval firing
 * is a no-op rather than stacking work.
 */
export async function tick(): Promise<void> {
	if (ticking) return;
	ticking = true;
	try {
		const now = Date.now();
		const due = await listDueJobs(now);
		if (due.length === 0) return;
		logDebug('jobs', 'scheduler tick: due jobs', { count: due.length });
		for (const job of due) {
			await processDueJob(job, now);
		}
	} catch (e) {
		console.warn('Scheduled jobs were not checked this tick:', errMessage(e));
	} finally {
		ticking = false;
	}
}

async function processDueJob(job: JobSummary, now: number): Promise<void> {
	// Interactive types open with an interview. Firing one unattended parks
	// the run on a question modal with nobody there to answer it, holding the
	// runner while every other run queues behind it. The editor hides the
	// schedule field for these types, so this only catches jobs saved before
	// that gate existed — clear the due time rather than skipping it, or the
	// job is re-examined on every tick forever.
	if (getJobType(job.job_type)?.supportsSchedule === false) {
		logDebug('jobs', 'scheduler: type cannot run unattended, clearing schedule', {
			jobId: job.id,
			jobType: job.job_type
		});
		await setJobNextDueAt(job.id, null);
		return;
	}
	// Recompute the next due time FIRST, using the previous next_due_at as
	// the anchor so interval cadence stays steady. Doing this before
	// enqueue avoids a race where a long-running enqueue might double-fire
	// on the next tick.
	const schedule = configJsonToSchedule(job.schedule_kind, job.schedule_config);
	if (schedule) {
		const next = computeNextDueAt(schedule, job.next_due_at, new Date(now));
		await setJobNextDueAt(job.id, next);
	} else {
		// Schedule config didn't deserialize — clear next_due_at so we don't
		// busy-loop on a broken job. The user will see "Manual" in the list.
		console.warn(
			`Job ${job.id} has a ${job.schedule_kind} schedule that could not be read; it is now manual`
		);
		await setJobNextDueAt(job.id, null);
	}

	if (await pausedWithHome(job.id)) {
		logDebug('jobs', 'scheduler: Home tab is off, skipping a card job', { jobId: job.id });
		return;
	}
	await enqueue(job.id, 'scheduled');
}

/**
 * Whether the job belongs to a Home card (Important emails, News) while
 * Settings → General → Home tab is off. Nobody would see its result, so its
 * scheduled run is skipped; Run now in the Jobs tab still runs it. A pinned
 * job, or one a card was given (Add card → Use a job), is the user's own and
 * keeps its schedule.
 */
async function pausedWithHome(jobId: number): Promise<boolean> {
	if (getSettings().homeTab) return false;
	await loadHomeCards();
	return getHomeCards().some(
		(c) => c.job_id === jobId && c.card_type !== 'pinned_job' && !cardUsesExistingJob(c)
	);
}
