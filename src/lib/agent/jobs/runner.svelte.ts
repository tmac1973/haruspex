/**
 * Job runner: owns run lifecycle — the FIFO queue, the reactive RunState the
 * UI subscribes to (getCurrentRun / currentStepIndex), abort, and persistence
 * mirroring into `job_runs` / `job_run_steps` via the jobRuns store.
 *
 * What a run *does* is the job type's business: the runner builds a
 * JobRunContext (run-scoped capabilities) and dispatches to the type's
 * registered pipeline (./types). Nothing here branches on job_type.
 */

import type { ResolvedToolCall } from '$lib/agent/parser';
import type { Artifact, LintIssue } from '$lib/agent/tools';
import type { SearchStep } from '$lib/agent/loop';
import {
	runEphemeralTurn,
	type EphemeralTurnOptions,
	type EphemeralTurnResult
} from '$lib/agent/runEphemeralTurn';
import type { BackendOverride } from '$lib/api';
import { withInferenceSlot } from '$lib/agent/inferenceQueue.svelte';
import { runWithAutoApprove } from '$lib/stores/approvalOverride';
import { getJob, type JobWithSteps, type JobType } from '$lib/stores/jobs.svelte';
import { getActiveContextSize, isVisionSupported } from '$lib/stores/settings';
// The registration barrel, deliberately — importing it registers the built-in
// job types before the first dispatch can happen.
import { getJobType, type JobRunContext, type PlannedStep } from './types';
import { markStepDone, newRunningStep } from '$lib/agent/steps';
import { createJobRun, markRunFinished, type JobRunStatus } from '$lib/stores/jobRuns.svelte';
import { logDebug } from '$lib/debug-log';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_input';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * The remote backend a job should run against, or undefined to use the global
 * Settings backend. Active iff the job has a non-blank remote base URL — the
 * override is remote-only by design (local jobs follow Settings). Applies to
 * every turn the job runs, regardless of job type.
 */
function jobBackendOverride(job: JobWithSteps): BackendOverride | undefined {
	const url = job.model_remote_base_url?.trim();
	if (!url) return undefined;
	return {
		baseUrl: url,
		apiKey: job.model_remote_api_key?.trim() || undefined,
		apiKeyId: job.model_remote_api_key_id ?? undefined,
		modelId: job.model_remote_model_id?.trim() || undefined
	};
}

/**
 * Run one ephemeral agent turn for a job under the shared harness: flip
 * `waitingForSlot` on the active run while it queues for an inference slot,
 * auto-approve tool calls (jobs are unattended), and inject the per-job
 * defaults — workspace dir (empty string from the DB → null so fs_* tools drop
 * out), backend override, and abort signal — on top of `opts`. Used by the
 * regular step, audit-sample, and cluster-verify turns.
 */
function runJobTurn(
	job: JobWithSteps,
	runId: number,
	abort: AbortController,
	opts: Omit<EphemeralTurnOptions, 'workingDir' | 'backend' | 'signal'>
): Promise<EphemeralTurnResult> {
	if (current && current.id === runId) {
		current = { ...current, waitingForSlot: true };
	}
	const backend = jobBackendOverride(job);
	return withInferenceSlot(
		{
			consumer: { kind: 'job', jobName: current?.jobName ?? `Job ${job.id}` },
			backend,
			signal: abort.signal,
			onAdmitted: () => {
				if (current && current.id === runId) current = { ...current, waitingForSlot: false };
			}
		},
		() =>
			runWithAutoApprove(() =>
				runEphemeralTurn({
					...opts,
					workingDir: job.working_dir ? job.working_dir : null,
					backend,
					signal: abort.signal
				})
			)
	);
}

/**
 * The context window (tokens) a job's turns should budget against. A remote
 * override carries its own size — usually much larger than the local default —
 * so we honour it when set; otherwise we fall back to the global active size.
 */
function jobContextSize(job: JobWithSteps): number {
	if (job.model_remote_base_url?.trim() && (job.model_remote_context_size ?? 0) > 0) {
		return job.model_remote_context_size as number;
	}
	return getActiveContextSize();
}

/**
 * Whether a job's turns should expose vision (image) tools. A remote override
 * can carry its own capability — when set (non-null) it wins; otherwise we
 * inherit the global Settings vision support. Matters for research jobs whose
 * override model differs from Settings; audit turns gate tools via an allowlist
 * that already excludes vision, so this is a no-op there.
 */
function jobVisionSupported(job: JobWithSteps): boolean {
	if (job.model_remote_base_url?.trim() && job.model_remote_vision_supported !== null) {
		return job.model_remote_vision_supported;
	}
	return isVisionSupported();
}

/** The concrete steps a run executes — each registered type plans its own. */
function planSteps(job: JobWithSteps): PlannedStep[] {
	return getJobType(job.job_type)?.planSteps(job) ?? [];
}

/**
 * One entry of a step's live sub-checklist (see RunStepState.checklist).
 * Generic on purpose: any type whose stage fans out over enumerable work
 * (the coding loop's TODO items, potentially audit's samples) can render
 * per-entry progress without a custom run-view component.
 */
export interface StepChecklistEntry {
	label: string;
	status: 'todo' | 'running' | 'done' | 'blocked';
	/** Short annotation shown after the label (e.g. "attempt 2/3"). */
	detail?: string;
}

export interface RunStepState {
	index: number;
	promptAuthored: string;
	/** With the previous step's output prepended (step 0 == authored). */
	promptRendered: string;
	deepResearch: boolean;
	/** Stage description for named-stage types (guided planning); null = the
	 *  step is a prompt and the run view renders promptAuthored instead. */
	description: string | null;
	/** Live sub-checklist rendered inside the step card (display-only, not
	 *  persisted); null for steps without enumerable sub-work. */
	checklist: StepChecklistEntry[] | null;
	status: StepStatus;
	streaming: string;
	output: string;
	error: string | null;
	searchSteps: SearchStep[];
	/**
	 * Soft warning emitted when the rendered prompt is suspiciously large
	 * relative to the active context budget (~80%). The step still runs;
	 * the UI just shows the warning so the user knows why the model
	 * truncated or returned poor output. Null when within budget.
	 */
	sizeWarning: string | null;
	startedAt: number | null;
	finishedAt: number | null;
}

export interface RunState {
	/** Persisted job_runs.id from the DB. */
	id: number;
	jobId: number;
	jobName: string;
	/** Job type, so the run view can render type-specific progress (e.g. the
	 *  named guided_planning stages). */
	jobType: JobType;
	steps: RunStepState[];
	currentStepIndex: number;
	status: RunStatus;
	error: string | null;
	/**
	 * True while the active step is parked in the app's inference queue
	 * (e.g. waiting behind a chat turn). UI renders a "waiting" hint so
	 * the run doesn't look frozen.
	 */
	waitingForSlot: boolean;
	startedAt: number;
	finishedAt: number | null;
}

/**
 * Snapshot of everything the runner needs to execute a queued run.
 * We capture this at enqueue time so subsequent edits to the underlying
 * job don't change what an already-queued run does — matches the
 * snapshotted prompts in `job_run_steps`.
 */
interface QueuedRun {
	runId: number;
	job: JobWithSteps;
	trigger: RunTrigger;
}

export interface PendingQueueEntry {
	runId: number;
	jobId: number;
	jobName: string;
	trigger: RunTrigger;
}

let current = $state<RunState | null>(null);
let pending = $state<QueuedRun[]>([]);
let activeAbort: AbortController | null = null;

export function getCurrentRun(): RunState | null {
	return current;
}

export function getPendingQueue(): PendingQueueEntry[] {
	return pending.map((q) => ({
		runId: q.runId,
		jobId: q.job.id,
		jobName: q.job.name,
		trigger: q.trigger
	}));
}

export function getQueueDepth(): number {
	return pending.length;
}

export function clearCurrentRun(): void {
	if (current?.status === 'running') return;
	current = null;
}

export type RunTrigger = 'manual' | 'scheduled';

export async function enqueue(
	jobId: number,
	trigger: RunTrigger = 'manual'
): Promise<number | null> {
	const job = await getJob(jobId);
	if (!job) {
		logDebug('jobs', 'enqueue failed: job not found', { jobId, trigger });
		return null;
	}
	const def = getJobType(job.job_type);
	if (!def) {
		logDebug('jobs', 'enqueue failed: job type not registered', { jobId, type: job.job_type });
		return null;
	}
	// Platform-gated types (autonomous coding needs the shell plumbing) — this
	// await is the authoritative check; the UI's availability cache only hides
	// the option.
	if (def.available && !(await def.available())) {
		logDebug('jobs', 'enqueue failed: job type unavailable on this platform', {
			jobId,
			type: job.job_type
		});
		return null;
	}
	// Types without planned steps (guided planning) drive their own stages —
	// the run is driven by config + interactive Q&A, not a step pipeline.
	if (def.hasPlannedSteps && job.steps.length === 0) {
		logDebug('jobs', 'enqueue failed: no steps', { jobId });
		return null;
	}

	const runId = await createJobRun(
		jobId,
		trigger,
		planSteps(job).map((s) => s.authored)
	);
	if (runId === null) {
		logDebug('jobs', 'enqueue failed: could not persist run row', { jobId, trigger });
		return null;
	}

	const queued: QueuedRun = { runId, job, trigger };

	if (current?.status === 'running') {
		pending.push(queued);
		logDebug('jobs', 'queued behind active run', {
			runId,
			jobId,
			trigger,
			depth: pending.length
		});
		return runId;
	}

	startRun(queued);
	return runId;
}

function startRun(queued: QueuedRun): void {
	const { runId, job } = queued;
	const abort = new AbortController();
	activeAbort = abort;

	const planned = planSteps(job);
	current = {
		id: runId,
		jobId: job.id,
		jobName: job.name,
		jobType: job.job_type,
		steps: planned.map((s, i) => ({
			index: i,
			promptAuthored: s.authored,
			// Steps that render their prompt at execution time (audit sample
			// wrapping, guided stages) start blank; the type's planner pre-fills
			// the rest (research step 0 has no prepend, so it shows as-authored).
			promptRendered: s.initialRendered ?? '',
			deepResearch: s.deepResearch,
			description: s.description ?? null,
			checklist: null,
			status: 'pending',
			streaming: '',
			output: '',
			error: null,
			searchSteps: [],
			sizeWarning: null,
			startedAt: null,
			finishedAt: null
		})),
		currentStepIndex: 0,
		status: 'running',
		error: null,
		waitingForSlot: false,
		startedAt: Date.now(),
		finishedAt: null
	};

	void runPipeline(queued, abort);
}

function drainNext(): void {
	const next = pending.shift();
	if (next) startRun(next);
}

function patchStep(runId: number, stepIndex: number, patch: Partial<RunStepState>): void {
	if (!current || current.id !== runId) return;
	const steps = current.steps.map((s, i) => (i === stepIndex ? { ...s, ...patch } : s));
	current = { ...current, steps };
}

function buildStreamCallbacks(runId: number, stepIndex: number) {
	return {
		onAssistantDelta: (full: string) => patchStep(runId, stepIndex, { streaming: full }),
		onToolStart: (call: ResolvedToolCall) => {
			if (!current || current.id !== runId) return;
			const step = current.steps[stepIndex];
			if (!step) return;
			patchStep(runId, stepIndex, {
				searchSteps: [...step.searchSteps, newRunningStep(call)]
			});
		},
		onToolEnd: (
			call: ResolvedToolCall,
			result: string,
			thumbDataUrl?: string,
			artifacts?: Artifact[],
			lintIssues?: LintIssue[]
		) => {
			if (!current || current.id !== runId) return;
			const step = current.steps[stepIndex];
			if (!step) return;
			patchStep(runId, stepIndex, {
				searchSteps: markStepDone(
					step.searchSteps,
					call,
					result,
					thumbDataUrl,
					artifacts,
					lintIssues
				)
			});
		}
	};
}

/**
 * The run-scoped capabilities a pipeline executes against — never the
 * runner's module state. `onSettled` owns the post-pipeline transition: if
 * there's a queued run it swaps the center pane straight into the next one;
 * if the queue is empty, `current` stays on the terminal state so the user
 * can read the result and dismiss it via Close (clearCurrentRun).
 */
function buildRunContext(
	job: JobWithSteps,
	runId: number,
	abort: AbortController,
	trigger: RunTrigger
): JobRunContext {
	return {
		job,
		runId,
		abort,
		trigger,
		runJobTurn: (opts) => runJobTurn(job, runId, abort, opts),
		patchStep: (stepIndex, patch) => patchStep(runId, stepIndex, patch),
		buildStreamCallbacks: (stepIndex) => buildStreamCallbacks(runId, stepIndex),
		setCurrentStepIndex: (stepIndex) => {
			if (current && current.id === runId) current = { ...current, currentStepIndex: stepIndex };
		},
		liveStepIndex: () => (current && current.id === runId ? current.currentStepIndex : 0),
		stepAuthored: (stepIndex) => current?.steps[stepIndex]?.promptAuthored ?? '',
		isLive: () => current?.id === runId,
		contextSize: () => jobContextSize(job),
		visionSupported: () => jobVisionSupported(job),
		finalizeRun: (status, error) => finalizeRun(runId, job.id, status, error),
		onSettled: () => {
			if (activeAbort === abort) activeAbort = null;
			if (pending.length > 0) queueMicrotask(drainNext);
		}
	};
}

async function runPipeline(queued: QueuedRun, abort: AbortController): Promise<void> {
	const { job, runId, trigger } = queued;
	const ctx = buildRunContext(job, runId, abort, trigger);
	const def = getJobType(job.job_type);
	if (def) return def.runPipeline(ctx);
	// Unknown type: enqueue() guards against this, but fail honestly rather
	// than silently doing nothing if a foreign DB row slips through.
	finalizeRun(runId, job.id, 'failed', `Job type "${job.job_type}" is not registered.`);
	ctx.onSettled();
}

function finalizeRun(runId: number, jobId: number, status: RunStatus, error: string | null): void {
	const finishedAt = Date.now();
	if (current && current.id === runId) {
		current = { ...current, status, error, finishedAt };
	}
	void markRunFinished(runId, jobId, status as JobRunStatus, finishedAt, error);
}

export function cancel(runId: number): void {
	if (!current || current.id !== runId) return;
	if (current.status !== 'running') return;
	activeAbort?.abort();
}
