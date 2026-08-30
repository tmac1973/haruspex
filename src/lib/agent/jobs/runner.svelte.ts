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
import type { CallStats, SearchStep } from '$lib/agent/loop';
import {
	runEphemeralTurn,
	type EphemeralTurnOptions,
	type EphemeralTurnResult
} from '$lib/agent/runEphemeralTurn';
import type { BackendOverride, Usage } from '$lib/api';
import { withInferenceSlot } from '$lib/agent/inferenceQueue.svelte';
import { runWithAutoApprove } from '$lib/stores/approvalOverride';
import { getJob, type JobWithSteps, type JobType } from '$lib/stores/jobs.svelte';
import { resolveBackendDescriptor } from '$lib/inference/descriptor';
import {
	getActiveLocalModelFilename,
	getSettings,
	type SamplingParams
} from '$lib/stores/settings';
import { parseModelAdvanced } from './modelAdvanced';
// The registration barrel, deliberately — importing it registers the built-in
// job types before the first dispatch can happen.
import { getJobType, type JobRunContext, type PlannedStep } from './types';
import { markStepDone, newRunningStep } from '$lib/agent/steps';
import {
	createJobRun,
	markRunFinished,
	setRunEnvironment,
	setStepStatsProvider,
	type JobRunStatus,
	type StepStats
} from '$lib/stores/jobRuns.svelte';
import { logDebug } from '$lib/debug-log';
import { setKeepAwake } from './keepAwake';

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
		modelId: job.model_remote_model_id?.trim() || undefined,
		contextSize: job.model_remote_context_size ?? undefined,
		visionSupported: job.model_remote_vision_supported ?? undefined,
		// What the editor's last probe of this server reported. Without it the
		// descriptor can only guess the model's reasoning mechanism from its
		// id, and guesses "none" for anything off the built-in Qwen list.
		// Omitted rather than null when never probed — absent is what the
		// descriptor reads as "fall back to the id guess".
		discovered: parseModelAdvanced(job.model_advanced).discovered ?? undefined
	};
}

/**
 * The per-job model behavior every turn of this job runs under. Resolved
 * here, once, rather than in each pipeline: `runJobTurn` already owns the
 * workspace dir, backend and abort signal, and these belong in the same set —
 * so all four job types get the controls and none can drift.
 */
function jobTurnPolicy(job: JobWithSteps): {
	thinkingEnabled: boolean | null;
	reasoningEffort: string | null;
	samplingSource: 'server' | 'profile' | 'custom';
	samplingParams: SamplingParams | null;
} {
	const advanced = parseModelAdvanced(job.model_advanced);
	const mode = advanced.reasoning.mode;
	return {
		thinkingEnabled: mode === 'inherit' ? null : mode === 'on',
		reasoningEffort: advanced.reasoning.effort,
		samplingSource: advanced.sampling.source,
		samplingParams: advanced.sampling.params
	};
}

/**
 * The resolved backend a job's turns run against: the job's remote override
 * when configured, otherwise the global Settings backend. Context size and
 * vision capability are read off this descriptor — an override carries its
 * own values (with global fallback when it omits them, matching the
 * pre-descriptor runner), so there is no parallel capability plumbing here.
 */
function jobDescriptor(job: JobWithSteps) {
	return resolveBackendDescriptor(jobBackendOverride(job));
}

/**
 * What a run executes under, as the stats card reports it.
 *
 * Resolved here at run start and persisted with the run, because the job's
 * settings are editable afterwards: reading them back at display time would
 * relabel a finished run's token table with a model that never touched it.
 * The reasoning fields are the job's own choice where it made one, and the
 * global Settings value where it inherits — i.e. what the turns actually ran
 * with, not the literal config.
 */
export interface RunEnvironment {
	/** Model name for display. Local runs report the active GGUF's filename. */
	modelId: string | null;
	/** Resolved reasoning toggle: the job's override, else the global setting. */
	modelThinking: boolean | null;
	/** Resolved reasoning effort, or null when none is selected. */
	modelEffort: string | null;
	contextSize: number | null;
}

function runEnvironment(job: JobWithSteps): RunEnvironment {
	const descriptor = jobDescriptor(job);
	const policy = jobTurnPolicy(job);
	const settings = getSettings();
	// llama-server serves one model and ignores the name, so the descriptor
	// reports the 'default' placeholder — the GGUF filename is the only thing
	// that identifies what actually answered.
	const local = getActiveLocalModelFilename().replace(/\.gguf$/i, '');
	const modelId =
		descriptor.kind === 'local' || descriptor.modelId === 'default'
			? local || 'local model'
			: descriptor.modelId;
	return {
		modelId,
		modelThinking: policy.thinkingEnabled ?? settings.thinkingEnabled,
		modelEffort: policy.reasoningEffort ?? settings.reasoningEffort,
		contextSize: descriptor.contextSize
	};
}

/**
 * Run one ephemeral agent turn for a job under the shared harness: flip
 * `waitingForSlot` on the active run while it queues for an inference slot,
 * auto-approve tool calls (jobs are unattended), and inject the per-job
 * defaults — workspace dir (empty string from the DB → null so fs_* tools drop
 * out), backend override, and abort signal — on top of `opts`. Used by the
 * regular step, audit-sample, and cluster-verify turns.
 *
 * `opts` is spread first so the job's own policy wins: a pipeline must not be
 * able to re-enable reasoning on a job whose owner turned it off.
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
					// Ordering is the contract: observability is a default a
					// pipeline may replace, the job's policy outranks the
					// pipeline, and the runner owns the last three outright.
					...observabilityCallbacks(runId),
					...opts,
					...jobTurnPolicy(job),
					workingDir: job.working_dir ? job.working_dir : null,
					backend,
					signal: abort.signal
				})
			)
	);
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

/**
 * How much of a step went to reasoning rather than answering.
 *
 * `totalMs` is the summed duration of the step's model calls, not its
 * wall-clock elapsed time — tool execution, file writes and git commits
 * happen between calls and are nobody's thinking. Comparing `reasoningMs`
 * against step elapsed would understate the share.
 */
export interface StepThinkingStats {
	reasoningMs: number;
	totalMs: number;
	reasoningTokens: number;
	totalTokens: number;
	/**
	 * Prompt tokens summed across the step's calls — tokens *processed*, not
	 * context size. One step is many independent turns (guided planning writes
	 * one phase file per turn), and every call re-sends its own prompt, so this
	 * counts re-sends by design. Locally llama.cpp reuses the KV cache for a
	 * shared prefix so they aren't recomputed; on a metered backend they are
	 * real spend.
	 */
	promptTokens: number;
	/**
	 * Largest single call's prompt — the high-water mark against the context
	 * window. The live gauge can't show this: it tracks the call in flight and
	 * resets whenever the step starts a fresh turn.
	 */
	peakPromptTokens: number;
	/**
	 * True only while every call in the step reported its own reasoning split.
	 * One estimated call makes the step's figure an estimate — the honest
	 * reading, and what stops the UI marking a mixed step as exact.
	 */
	reasoningExact: boolean;
	/** Number of model calls folded in — the sample size behind the estimate. */
	calls: number;
}

/** Fold one call's stats into a step's running totals. */
export function addCallStats(prev: StepThinkingStats | null, call: CallStats): StepThinkingStats {
	return {
		reasoningMs: (prev?.reasoningMs ?? 0) + call.reasoningMs,
		totalMs: (prev?.totalMs ?? 0) + call.durationMs,
		reasoningTokens: (prev?.reasoningTokens ?? 0) + call.reasoningTokens,
		totalTokens: (prev?.totalTokens ?? 0) + call.completionTokens,
		promptTokens: (prev?.promptTokens ?? 0) + call.promptTokens,
		peakPromptTokens: Math.max(prev?.peakPromptTokens ?? 0, call.promptTokens),
		reasoningExact: (prev?.reasoningExact ?? true) && call.reasoningExact,
		calls: (prev?.calls ?? 0) + 1
	};
}

/**
 * The wire shape of a step's totals, or null when it ran no model calls —
 * which is a real state (a checkpoint stage waiting on the user) and must
 * persist as "not recorded" rather than as zeros.
 */
export function stepStatsWire(stats: StepThinkingStats | null): StepStats | null {
	if (!stats || stats.calls === 0) return null;
	return {
		tokens_prompt: stats.promptTokens,
		tokens_completion: stats.totalTokens,
		tokens_reasoning: stats.reasoningTokens,
		tokens_reasoning_exact: stats.reasoningExact,
		peak_prompt_tokens: stats.peakPromptTokens,
		model_calls: stats.calls,
		reasoning_ms: stats.reasoningMs,
		total_ms: stats.totalMs
	};
}

// The store closes steps for every job type; the totals live here. Registering
// once means a job type added later records its tokens without touching any of
// the nine finish call sites. See `setStepStatsProvider`.
setStepStatsProvider((runId, ordering) =>
	current && current.id === runId ? stepStatsWire(current.steps[ordering]?.thinking ?? null) : null
);

/**
 * The inverse of `stepStatsWire`: a persisted row read back into the same
 * shape a live step carries. One shape means the stats card renders a finished
 * run and a running one with one component, instead of two that drift.
 */
export function stepStatsFromWire(stats: StepStats | null): StepThinkingStats | null {
	if (!stats) return null;
	return {
		reasoningMs: stats.reasoning_ms,
		totalMs: stats.total_ms,
		reasoningTokens: stats.tokens_reasoning,
		totalTokens: stats.tokens_completion,
		promptTokens: stats.tokens_prompt,
		peakPromptTokens: stats.peak_prompt_tokens,
		reasoningExact: stats.tokens_reasoning_exact,
		calls: stats.model_calls
	};
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
	/**
	 * This step's reasoning, session-only — deliberately never persisted to
	 * job_runs (an overnight run's traces are large and their value decays
	 * fast). Accumulated across the step's model calls, since one step is a
	 * multi-iteration agent loop.
	 */
	reasoning: string;
	/** Latest prompt/completion token usage reported by this step's calls. */
	usage: { promptTokens: number; completionTokens: number } | null;
	/**
	 * Thinking-vs-answering totals for the step, summed over its model calls.
	 * Token and millisecond figures are apportioned estimates — see
	 * `CallStats`. Display-only, like `checklist` below.
	 */
	thinking: StepThinkingStats | null;
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
	/**
	 * Context window of the model THIS run uses — the job's override when it
	 * has one, else the Settings backend. Carried on the run so the UI can
	 * gauge a step's token usage against the right ceiling instead of the
	 * globally-active model's.
	 */
	contextSize: number;
	/** Model / reasoning settings this run executes under. See RunEnvironment. */
	environment: RunEnvironment;
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

// Hold the machine awake for as long as there is work. The scheduler ticker
// and every pipeline are JS in the webview, so an OS suspend doesn't just
// pause inference — it stalls the run loop outright, and since the process
// survives, the run isn't swept into 'interrupted' either; it sits at
// 'running' until someone notices. A module-level $effect.root (same pattern
// as the queued-send watcher in stores/chat.svelte.ts) derives the intent
// from the state that already exists rather than from calls sprinkled
// through startRun / finalizeRun / drainNext, so no path can forget one.
// Batching is a bonus: a finish that immediately drains the next queued run
// settles as a single no-op instead of a release/acquire round trip.
$effect.root(() => {
	$effect(() => {
		setKeepAwake(current?.status === 'running' || pending.length > 0);
	});
});

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
	const environment = runEnvironment(job);
	// Fire-and-forget: a failed environment write costs the stats card its
	// model label, which must never be a reason a run does not start.
	void setRunEnvironment(runId, environment);
	current = {
		id: runId,
		jobId: job.id,
		jobName: job.name,
		jobType: job.job_type,
		contextSize: environment.contextSize ?? 0,
		environment,
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
			reasoning: '',
			usage: null,
			thinking: null,
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

/**
 * Observability hooks attached to every job turn, whatever the type and
 * whether or not the pipeline opted into stream callbacks.
 *
 * Attribution follows `currentStepIndex` — the same "which step is live"
 * signal the runner already uses to pin an error to a step — resolved at call
 * time rather than captured, because one `runJobTurn` call can outlive the
 * step index it started under. A pipeline that never calls
 * `setCurrentStepIndex` folds everything into step 0, exactly as its errors
 * already would.
 */
function observabilityCallbacks(runId: number) {
	const liveStep = () => (current && current.id === runId ? current.currentStepIndex : 0);
	return {
		onUsageUpdate: (usage: Usage) =>
			patchStep(runId, liveStep(), {
				usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
			}),
		onCallStats: (stats: CallStats) => {
			if (!current || current.id !== runId) return;
			const idx = liveStep();
			patchStep(runId, idx, {
				thinking: addCallStats(current.steps[idx]?.thinking ?? null, stats)
			});
		},
		onReasoning: (reasoning: string) => {
			if (!current || current.id !== runId) return;
			const idx = liveStep();
			const prev = current.steps[idx]?.reasoning ?? '';
			// One step is many model calls; separate them so the disclosure
			// reads as a sequence of thoughts rather than one run-on block.
			patchStep(runId, idx, { reasoning: prev ? `${prev}\n\n---\n\n${reasoning}` : reasoning });
		}
	};
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
		contextSize: () => jobDescriptor(job).contextSize,
		visionSupported: () => jobDescriptor(job).vision,
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
