import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '$lib/debug-log';

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
	try {
		const rows = await invoke<JobRunSummary[]>('db_list_job_runs', { jobId });
		runsByJob[jobId] = rows;
	} catch (e) {
		logDebug('jobs', 'loadRunsForJob failed', { jobId, error: String(e) });
		runsByJob[jobId] = [];
	}
}

export async function getJobRun(runId: number): Promise<JobRunWithSteps | null> {
	try {
		return await invoke<JobRunWithSteps>('db_get_job_run', { runId });
	} catch (e) {
		logDebug('jobs', 'getJobRun failed', { runId, error: String(e) });
		return null;
	}
}

export async function createJobRun(
	jobId: number,
	trigger: 'manual' | 'scheduled',
	stepPrompts: string[]
): Promise<number | null> {
	try {
		const id = await invoke<number>('db_create_job_run', {
			jobId,
			trigger,
			stepPrompts
		});
		void loadRunsForJob(jobId);
		return id;
	} catch (e) {
		logDebug('jobs', 'createJobRun failed', { jobId, error: String(e) });
		return null;
	}
}

export async function markRunStarted(runId: number, startedAt: number): Promise<void> {
	try {
		await invoke('db_mark_run_started', { runId, startedAt });
	} catch (e) {
		logDebug('jobs', 'markRunStarted failed', { runId, error: String(e) });
	}
}

export async function markRunFinished(
	runId: number,
	jobId: number,
	status: JobRunStatus,
	finishedAt: number,
	error: string | null
): Promise<void> {
	try {
		await invoke('db_mark_run_finished', {
			runId,
			status,
			finishedAt,
			error
		});
	} catch (e) {
		logDebug('jobs', 'markRunFinished failed', { runId, error: String(e) });
	}
	void loadRunsForJob(jobId);
}

export async function markRunStepStarted(
	runId: number,
	ordering: number,
	startedAt: number,
	promptRendered: string
): Promise<void> {
	try {
		await invoke('db_mark_run_step_started', {
			runId,
			ordering,
			startedAt,
			promptRendered
		});
	} catch (e) {
		logDebug('jobs', 'markRunStepStarted failed', { runId, ordering, error: String(e) });
	}
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
	try {
		await invoke('db_mark_run_step_finished', {
			runId,
			ordering,
			status,
			output,
			error,
			finishedAt
		});
	} catch (e) {
		logDebug('jobs', 'markRunStepFinished failed', { runId, ordering, error: String(e) });
	}
}
