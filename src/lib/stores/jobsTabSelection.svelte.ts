/**
 * A selection for the Jobs tab made from somewhere else (a Home card): the
 * caller sets it and switches tab, and `JobsTab` takes it when it mounts or
 * when it changes. One at a time, a job to show or a new job to start from;
 * a new one replaces the last.
 */
import type { JobType } from '#lib/stores/jobs.svelte.ts';

/** A new job's starting values, shown unsaved in the editor. */
export interface JobDraft {
	jobType: JobType;
	name: string;
	workingDir: string;
	/** The type's settings, laid over its defaults. */
	config: Record<string, unknown>;
}

export type JobsTabSelection =
	| {
			kind: 'job';
			jobId: number;
			/** A run of that job to show, or null for the job alone. */
			runId: number | null;
	  }
	| { kind: 'draft'; draft: JobDraft };

let pending = $state<JobsTabSelection | null>(null);

/** Ask the Jobs tab to show a job, and one of its runs when `runId` is given. */
export function selectJob(jobId: number, runId: number | null = null): void {
	pending = { kind: 'job', jobId, runId };
}

/** Ask the Jobs tab to open a new job filled in from `draft`, not saved. */
export function newJobDraft(draft: JobDraft): void {
	pending = { kind: 'draft', draft };
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
