import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '$lib/debug-log';
import { dbMutate, dbQuery } from './dbCall';

export type JobRunStatus =
	| 'queued'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'cancelled'
	| 'interrupted'
	// Parked mid-run waiting on user input (guided_planning with no live user);
	// resumes when the user answers. See the guided_planning runner.
	| 'needs_input';

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
	/**
	 * Serialized guided_planning resume state (stage, milestone, approved
	 * outline). null for non-guided runs. Mirrors job_runs.planning_state.
	 */
	planning_state: string | null;
}

/**
 * Token and timing totals for one finished step, as stored. Snake_case to
 * match the Rust `StepStats` wire shape verbatim.
 *
 * `tokens_prompt` is tokens *processed*: a step is many independent turns and
 * each re-sends its own prompt, so this counts re-sends by design. It is not
 * context size — `peak_prompt_tokens` is what compares against the window.
 */
export interface StepStats {
	tokens_prompt: number;
	tokens_completion: number;
	tokens_reasoning: number;
	/** Whether the reasoning figure came from the backend or was estimated. */
	tokens_reasoning_exact: boolean;
	peak_prompt_tokens: number;
	model_calls: number;
	reasoning_ms: number;
	total_ms: number;
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
	/**
	 * null for a step that ran no model calls, was interrupted, or predates
	 * token accounting. Deliberately distinct from a row of zeros: "not
	 * recorded" and "spent nothing" read very differently in a stats table.
	 */
	stats: StepStats | null;
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

/**
 * How `markRunStepFinished` finds the token totals for the step it closes.
 *
 * Injected by the runner at module load rather than passed at each call site:
 * the figures live in the runner's live run state, and there are nine finish
 * calls across four pipelines. An argument threaded through nine places is one
 * a fifth job type silently forgets — the same drift the runner's own
 * `jobTurnPolicy` comment exists to prevent. One provider means every job type
 * records, including ones not written yet.
 */
let stepStatsProvider: ((runId: number, ordering: number) => StepStats | null) | null = null;

export function setStepStatsProvider(
	provider: (runId: number, ordering: number) => StepStats | null
): void {
	stepStatsProvider = provider;
}

export async function markRunStepFinished(
	runId: number,
	ordering: number,
	status: JobRunStepStatus,
	output: string | null,
	error: string | null,
	finishedAt: number
): Promise<void> {
	// Resolved here, at the moment the step closes, so it reflects every call
	// the step made. A step that ran no model calls resolves to null.
	const stats = stepStatsProvider?.(runId, ordering) ?? null;
	await dbMutate({
		cmd: 'db_mark_run_step_finished',
		args: { runId, ordering, status, output, error, finishedAt, stats },
		onError: 'markRunStepFinished failed',
		ctx: { runId, ordering }
	});
}
