/**
 * What a Home card shows about its job's runs. Plain functions over the
 * runner's and the run list's reactive state, so a card reads them inside
 * `$derived` and follows runs as they start, wait and finish.
 */
import { getActiveRunForJob, getPendingQueue } from '#lib/agent/jobs/runner.svelte.ts';
import { getLatestRun } from '#lib/home/latestRun.svelte.ts';

/** Whether a run of `jobId` is waiting in the queue. */
export function jobQueued(jobId: number | null): boolean {
	return jobId !== null && getPendingQueue().some((q) => q.jobId === jobId);
}

/** A card's job: its latest run, the live one, and whether it runs, waits, queues or failed. */
export function cardRunState(jobId: number | null) {
	const latestRun = jobId === null ? null : getLatestRun(jobId);
	const run = jobId === null ? null : getActiveRunForJob(jobId);
	const running = run?.status === 'running';
	return {
		latestRun,
		run,
		running,
		waiting: running && (run?.waitingForSlot ?? false),
		queued: jobQueued(jobId),
		failed: latestRun?.latest?.status === 'failed' ? latestRun.latest : null
	};
}
