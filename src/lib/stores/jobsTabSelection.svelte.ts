/**
 * A selection for the Jobs tab made from somewhere else (a Home card): the
 * caller sets it and switches tab, and `JobsTab` takes it when it mounts or
 * when it changes. One at a time; a new one replaces the last.
 */

export interface JobsTabSelection {
	jobId: number;
	/** A run of that job to show, or null for the job alone. */
	runId: number | null;
}

let pending = $state<JobsTabSelection | null>(null);

/** Ask the Jobs tab to show a job, and one of its runs when `runId` is given. */
export function selectJob(jobId: number, runId: number | null = null): void {
	pending = { jobId, runId };
}

export function getPendingSelection(): JobsTabSelection | null {
	return pending;
}

/** The pending selection, cleared. */
export function takePendingSelection(): JobsTabSelection | null {
	const taken = pending;
	pending = null;
	return taken;
}

export function _resetForTests(): void {
	pending = null;
}
