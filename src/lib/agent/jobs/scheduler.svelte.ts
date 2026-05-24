/**
 * In-app job scheduler.
 *
 * A single setInterval ticker polls the DB for jobs whose `next_due_at`
 * has passed and hands them to the runner with trigger='scheduled'.
 * After enqueue we recompute and persist the next due time, so cadence
 * stays steady even if the runner queues the work behind other runs.
 *
 * Scope per phase plan: the app must be open for this to fire. If the
 * app is closed when a schedule comes due, that fire is dropped — not
 * retro-run on next launch. The job editor surfaces this constraint in
 * its schedule field.
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
} from '$lib/stores/jobs.svelte';
import { enqueue } from '$lib/agent/jobs/runner.svelte';
import { logDebug } from '$lib/debug-log';

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
		logDebug('jobs', 'scheduler tick failed', { error: String(e) });
	} finally {
		ticking = false;
	}
}

async function processDueJob(job: JobSummary, now: number): Promise<void> {
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
		logDebug('jobs', 'scheduler: failed to parse schedule, clearing', {
			jobId: job.id,
			schedule_kind: job.schedule_kind
		});
		await setJobNextDueAt(job.id, null);
	}

	await enqueue(job.id, 'scheduled');
}
