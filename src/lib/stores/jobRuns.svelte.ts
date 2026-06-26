import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '$lib/debug-log';
import { dbMutate, dbQuery } from './dbCall';

export type JobRunStatus =
	| 'queued'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'cancelled'
	| 'interrupted';

export type JobRunStepStatus =
	| 'pending'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'skipped'
	| 'cancelled';

export interface JobRunSummary {
	id: number;
	job_id: number;
	status: JobRunStatus;
	trigger: 'manual' | 'scheduled';
	queued_at: number;
	started_at: number | null;
	finished_at: number | null;
	error: string | null;
}

export interface JobRunStep {
	id: number;
	run_id: number;
	ordering: number;
	prompt_authored: string;
	prompt_rendered: string;
	status: JobRunStepStatus;
	output: string | null;
	started_at: number | null;
	finished_at: number | null;
	error: string | null;
}

export interface JobRunWithSteps extends JobRunSummary {
	steps: JobRunStep[];
}

// Per-job cache so the right-pane history list stays reactive without
// re-querying on every render. Refreshed whenever a run transitions.
const runsByJob = $state<Record<number, JobRunSummary[]>>({});

export function getRunsForJob(jobId: number): JobRunSummary[] {
	return runsByJob[jobId] ?? [];
}

export async function loadRunsForJob(jobId: number): Promise<void> {
	runsByJob[jobId] = await dbQuery<JobRunSummary[]>({
		cmd: 'db_list_job_runs',
		args: { jobId },
		fallback: [],
		onError: 'loadRunsForJob failed',
		ctx: { jobId }
	});
}

export function getJobRun(runId: number): Promise<JobRunWithSteps | null> {
	return dbQuery<JobRunWithSteps | null>({
		cmd: 'db_get_job_run',
		args: { runId },
		fallback: null,
		onError: 'getJobRun failed',
		ctx: { runId }
	});
}

export function createJobRun(
	jobId: number,
	trigger: 'manual' | 'scheduled',
	stepPrompts: string[]
): Promise<number | null> {
	return dbQuery<number | null>({
		cmd: 'db_create_job_run',
		args: { jobId, trigger, stepPrompts },
		fallback: null,
		onError: 'createJobRun failed',
		ctx: { jobId },
		// Fire-and-forget refresh — the caller gets the id without waiting.
		onSuccess: () => {
			void loadRunsForJob(jobId);
		}
	});
}

export function deleteJobRun(jobId: number, runId: number): Promise<boolean> {
	return dbMutate({
		cmd: 'db_delete_job_run',
		args: { runId },
		onError: 'deleteJobRun failed',
		ctx: { jobId, runId },
		onSuccess: () => {
			runsByJob[jobId] = (runsByJob[jobId] ?? []).filter((r) => r.id !== runId);
		}
	});
}

export function deleteAllJobRuns(jobId: number): Promise<boolean> {
	return dbMutate({
		cmd: 'db_delete_all_job_runs',
		args: { jobId },
		onError: 'deleteAllJobRuns failed',
		ctx: { jobId },
		onSuccess: () => {
			runsByJob[jobId] = [];
		}
	});
}

export async function markRunStarted(runId: number, startedAt: number): Promise<void> {
	await dbMutate({
		cmd: 'db_mark_run_started',
		args: { runId, startedAt },
		onError: 'markRunStarted failed',
		ctx: { runId }
	});
}

export async function markRunFinished(
	runId: number,
	jobId: number,
	status: JobRunStatus,
	finishedAt: number,
	error: string | null
): Promise<void> {
	// Reload regardless of success so a failed status write still refreshes the
	// list off whatever the DB now holds.
	await dbMutate({
		cmd: 'db_mark_run_finished',
		args: { runId, status, finishedAt, error },
		onError: 'markRunFinished failed',
		ctx: { runId }
	});
	void loadRunsForJob(jobId);
}

export async function markRunStepStarted(
	runId: number,
	ordering: number,
	startedAt: number,
	promptRendered: string
): Promise<void> {
	await dbMutate({
		cmd: 'db_mark_run_step_started',
		args: { runId, ordering, startedAt, promptRendered },
		onError: 'markRunStepStarted failed',
		ctx: { runId, ordering }
	});
}

/**
 * Sweep run rows orphaned by the previous session — anything stuck at
 * 'queued' or 'running' becomes 'interrupted'. Called once at app startup
 * before any Jobs UI mounts so the user never sees a stale "running" row
 * left behind by a hard close or crash. Idempotent.
 */
export async function recoverOrphanRuns(): Promise<number> {
	try {
		const swept = await invoke<number>('db_recover_orphan_runs');
		if (swept > 0) {
			logDebug('jobs', 'recoverOrphanRuns swept stale rows', { swept });
		}
		return swept;
	} catch (e) {
		logDebug('jobs', 'recoverOrphanRuns failed', { error: String(e) });
		return 0;
	}
}

export async function markRunStepFinished(
	runId: number,
	ordering: number,
	status: JobRunStepStatus,
	output: string | null,
	error: string | null,
	finishedAt: number
): Promise<void> {
	await dbMutate({
		cmd: 'db_mark_run_step_finished',
		args: { runId, ordering, status, output, error, finishedAt },
		onError: 'markRunStepFinished failed',
		ctx: { runId, ordering }
	});
}
