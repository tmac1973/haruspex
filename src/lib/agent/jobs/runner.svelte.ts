/**
 * Multi-step job runner.
 *
 * Walks all steps in a job, prepending the previous step's output to each
 * subsequent step's prompt. On first failure the run halts; remaining
 * steps stay `pending`. Each transition is mirrored into `job_runs` /
 * `job_run_steps` via the jobRuns store, so past runs are browsable in
 * the right pane after the fact.
 *
 * No queue yet (lands in step 7). Crash recovery (orphaned `running`
 * rows on app restart) lands in step 6.
 *
 * The UI subscribes to `getCurrentRun()` and reads `currentStepIndex`
 * to know which step is live.
 */

import type { ResolvedToolCall } from '$lib/agent/parser';
import type { Artifact, LintIssue } from '$lib/agent/tools';
import type { SearchStep } from '$lib/agent/loop';
import { runEphemeralTurn } from '$lib/agent/runEphemeralTurn';
import { withInferenceSlot } from '$lib/agent/inferenceQueue.svelte';
import { runWithAutoApprove } from '$lib/stores/approvalOverride';
import { getJob, type JobWithSteps } from '$lib/stores/jobs.svelte';
import { getActiveContextSize, isVisionSupported } from '$lib/stores/settings';
import { markStepDone, newRunningStep } from '$lib/agent/steps';
import { errMessage } from '$lib/utils/error';
import {
	createJobRun,
	markRunFinished,
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted,
	type JobRunStatus,
	type JobRunStepStatus
} from '$lib/stores/jobRuns.svelte';
import { logDebug } from '$lib/debug-log';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunStepState {
	index: number;
	promptAuthored: string;
	/** With the previous step's output prepended (step 0 == authored). */
	promptRendered: string;
	deepResearch: boolean;
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

/**
 * Crude characters→tokens ratio. Llama-family BPEs land in the 3-4
 * range; we use 4 because over-estimating budget hurts more than
 * under-estimating (we'd rather warn too often than miss a too-big
 * prompt).
 */
const CHARS_PER_TOKEN = 4;
const PROMPT_BUDGET_FRACTION = 0.8;

function estimateSizeWarning(rendered: string, contextSize: number): string | null {
	if (contextSize <= 0) return null;
	const estTokens = Math.ceil(rendered.length / CHARS_PER_TOKEN);
	const budget = Math.floor(contextSize * PROMPT_BUDGET_FRACTION);
	if (estTokens <= budget) return null;
	return (
		`Rendered prompt is roughly ${estTokens.toLocaleString()} tokens — ` +
		`above ${Math.round(PROMPT_BUDGET_FRACTION * 100)}% of the ${contextSize.toLocaleString()}-token context. ` +
		`The model may truncate, hallucinate, or run out of room for its reply. ` +
		`Consider splitting this step further.`
	);
}

export interface RunState {
	/** Persisted job_runs.id from the DB. */
	id: number;
	jobId: number;
	jobName: string;
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
	if (job.steps.length === 0) {
		logDebug('jobs', 'enqueue failed: no steps', { jobId });
		return null;
	}

	const runId = await createJobRun(
		jobId,
		trigger,
		job.steps.map((s) => s.prompt)
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

	current = {
		id: runId,
		jobId: job.id,
		jobName: job.name,
		steps: job.steps.map((s, i) => ({
			index: i,
			promptAuthored: s.prompt,
			promptRendered: i === 0 ? s.prompt : '',
			deepResearch: s.deep_research,
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

	void runPipeline(job, abort, runId);
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

function renderPrompt(stepIndex: number, authored: string, priorOutput: string): string {
	if (stepIndex === 0) return authored;
	if (!priorOutput) return authored;
	return `${priorOutput}\n\n${authored}`;
}

async function runOneStep(
	job: JobWithSteps,
	runId: number,
	stepIndex: number,
	rendered: string,
	abort: AbortController
): Promise<{ ok: true; output: string } | { ok: false; aborted: boolean; error: string }> {
	const step = job.steps[stepIndex];
	const visionSupported = isVisionSupported();
	const startedAt = Date.now();

	const contextSize = getActiveContextSize();
	const sizeWarning = estimateSizeWarning(rendered, contextSize);
	if (sizeWarning) {
		logDebug('jobs', 'step prompt over budget', {
			runId,
			stepIndex,
			length: rendered.length,
			contextSize
		});
	}
	patchStep(runId, stepIndex, {
		status: 'running',
		promptRendered: rendered,
		sizeWarning,
		startedAt
	});
	if (current && current.id === runId) {
		current = { ...current, currentStepIndex: stepIndex };
	}
	void markRunStepStarted(runId, stepIndex, startedAt, rendered);

	const callbacks = buildStreamCallbacks(runId, stepIndex);
	const wrap = job.auto_approve_tools ? runWithAutoApprove : passthrough;

	try {
		if (current && current.id === runId) {
			current = { ...current, waitingForSlot: true };
		}
		const { finalText } = await withInferenceSlot(
			{
				consumer: { kind: 'job', jobName: current?.jobName ?? `Job ${job.id}` },
				signal: abort.signal,
				onAdmitted: () => {
					if (current && current.id === runId) {
						current = { ...current, waitingForSlot: false };
					}
				}
			},
			() =>
				wrap(() =>
					runEphemeralTurn({
						userMessage: rendered,
						// Empty string from the DB means "no workdir for this job" —
						// translate to null so the agent loop filters out fs_*
						// tools entirely (same path as a chat with no workdir).
						workingDir: job.working_dir ? job.working_dir : null,
						contextSize,
						deepResearch: step.deep_research,
						visionSupported,
						signal: abort.signal,
						...callbacks
					})
				)
		);
		const finishedAt = Date.now();
		patchStep(runId, stepIndex, {
			status: 'succeeded',
			output: finalText,
			finishedAt
		});
		void markRunStepFinished(runId, stepIndex, 'succeeded', finalText, null, finishedAt);
		return { ok: true, output: finalText };
	} catch (e) {
		const aborted = e instanceof DOMException && e.name === 'AbortError';
		const msg = aborted ? 'Cancelled by user' : errMessage(e);
		const stepStatus: JobRunStepStatus = aborted ? 'cancelled' : 'failed';
		const finishedAt = Date.now();
		patchStep(runId, stepIndex, {
			status: stepStatus,
			error: msg,
			finishedAt
		});
		void markRunStepFinished(runId, stepIndex, stepStatus, null, msg, finishedAt);
		return { ok: false, aborted, error: msg };
	}
}

async function runPipeline(
	job: JobWithSteps,
	abort: AbortController,
	runId: number
): Promise<void> {
	void markRunStarted(runId, Date.now());
	let priorOutput = '';
	try {
		for (let i = 0; i < job.steps.length; i++) {
			if (!current || current.id !== runId) return;
			// If the user cancelled between steps, finalize cleanly without
			// flickering the next step to 'running' before bailing.
			if (abort.signal.aborted) {
				finalizeRun(runId, job.id, 'cancelled', 'Cancelled by user');
				return;
			}
			const authored = job.steps[i].prompt;
			const rendered = renderPrompt(i, authored, priorOutput);
			const result = await runOneStep(job, runId, i, rendered, abort);
			if (!result.ok) {
				const status: RunStatus = result.aborted ? 'cancelled' : 'failed';
				finalizeRun(runId, job.id, status, result.error);
				return;
			}
			priorOutput = result.output;
		}
		finalizeRun(runId, job.id, 'succeeded', null);
	} finally {
		if (activeAbort === abort) activeAbort = null;
		// If there's a queued run, transition immediately so the center
		// pane swaps from the just-finished run straight into the next
		// one. If the queue is empty, leave `current` on the terminal
		// state so the user can read the result and dismiss it manually
		// via the Close button (clearCurrentRun).
		if (pending.length > 0) {
			queueMicrotask(drainNext);
		}
	}
}

function finalizeRun(runId: number, jobId: number, status: RunStatus, error: string | null): void {
	const finishedAt = Date.now();
	if (current && current.id === runId) {
		current = { ...current, status, error, finishedAt };
	}
	void markRunFinished(runId, jobId, status as JobRunStatus, finishedAt, error);
}

function passthrough<T>(fn: () => Promise<T>): Promise<T> {
	return fn();
}

export function cancel(runId: number): void {
	if (!current || current.id !== runId) return;
	if (current.status !== 'running') return;
	activeAbort?.abort();
}
