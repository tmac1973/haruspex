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

import { invoke } from '@tauri-apps/api/core';
import type { ResolvedToolCall } from '$lib/agent/parser';
import type { Artifact, LintIssue } from '$lib/agent/tools';
import type { SearchStep } from '$lib/agent/loop';
import {
	SUBMIT_FINDINGS_TOOL,
	SUBMIT_VERDICT_TOOL,
	type AuditFinding,
	type AuditVerdict
} from '$lib/agent/tools/audit';
import { SUBMIT_PLAN_OUTLINE_TOOL, type PlanOutlinePhaseArg } from '$lib/agent/tools/planning';
import type { FindingCluster } from './auditCluster';
import {
	orchestrateAudit,
	buildSamplePrompt,
	buildVerifyPrompt,
	DEFAULT_AUDIT_SYNTHESIS_PROMPT
} from './auditPipeline';
import {
	runEphemeralTurn,
	type EphemeralTurnOptions,
	type EphemeralTurnResult
} from '$lib/agent/runEphemeralTurn';
import type { BackendOverride } from '$lib/api';
import { withInferenceSlot } from '$lib/agent/inferenceQueue.svelte';
import { runWithAutoApprove } from '$lib/stores/approvalOverride';
import { getJob, type JobWithSteps, type JobType } from '$lib/stores/jobs.svelte';
import { askUserQuestion } from '$lib/stores/userQuestion.svelte';
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

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_input';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * Guided-planning resume record, persisted to job_runs.planning_state (JSON) at
 * each milestone so a closed/crashed session resumes from the last one. The
 * runner re-enters the recorded stage; Q&A since the last milestone is re-done.
 * Wired up by the guided_planning runner (Phase 05+).
 */
export type PlanningStage = 'overview' | 'planning' | 'done';

export interface PhaseOutline {
	id: string;
	title: string;
	dependsOn: string[];
	summary: string;
}

export interface PlanningState {
	stage: PlanningStage;
	/** e.g. 'overview_written', 'phase_03_written'. */
	milestone: string;
	/** Set once the dependency map is approved; null before that. */
	approvedOutline: PhaseOutline[] | null;
	/** Checkpoint currently awaiting the user, if any. */
	pendingCheckpoint: 'overview_review' | 'dep_map' | null;
}

/** Read-only investigation toolset shared by audit sample + verification turns. */
const AUDIT_READ_TOOLS = ['code_grep', 'code_glob', 'fs_read_text', 'fs_list_dir'];
const SAMPLE_ALLOW = [...AUDIT_READ_TOOLS, SUBMIT_FINDINGS_TOOL];
const VERIFY_ALLOW = [...AUDIT_READ_TOOLS, SUBMIT_VERDICT_TOOL];
/** Upper bound on sample runs per audit, regardless of configured value. */
const MAX_AUDIT_RUNS = 20;
/**
 * Per-sample agent-loop turn budget. A thorough whole-codebase audit is mostly
 * grepping and reading and can take 100+ turns on a large repo — far more than
 * a normal chat turn (default 10). This is the ceiling on exploration, not a
 * give-up point: when it's exhausted the loop FORCES a submit_findings call
 * (see `forceFinalTool`), so a run never ends empty just for running long.
 * Configurable per job (`audit_max_iterations`); clamped to [1, MAX].
 */
const DEFAULT_AUDIT_SAMPLE_ITERATIONS = 200;
const MAX_AUDIT_SAMPLE_ITERATIONS = 400;
/**
 * Turn budget for a single cluster-verification turn. Verifying one finding
 * against source is focused (a handful of greps/reads), so it needs far less
 * room than a sample sweep — but more than the chat default in case the cited
 * code spans several files. submit_verdict is likewise force-called at the cap.
 */
const AUDIT_VERIFY_MAX_ITERATIONS = 40;

/** Resolve a job's configured sample budget to a sane, bounded turn count. */
function auditSampleIterations(job: JobWithSteps): number {
	const raw = job.audit_max_iterations ?? DEFAULT_AUDIT_SAMPLE_ITERATIONS;
	return Math.max(1, Math.min(Math.floor(raw), MAX_AUDIT_SAMPLE_ITERATIONS));
}

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

interface PlannedStep {
	authored: string;
	deepResearch: boolean;
}

/**
 * The concrete steps a run executes. Research jobs map 1:1 to their authored
 * steps; audit jobs expand into N sample steps (the same prompt, run
 * independently) plus a trailing synthesis step.
 */
function planSteps(job: JobWithSteps): PlannedStep[] {
	if (job.job_type === 'guided_planning') {
		// Display stages — the run advances through these so the UI shows where
		// in the process it is. Indices must match GUIDED_STAGES in the pipeline.
		return [
			{ authored: 'Overview', deepResearch: false },
			{ authored: 'Outline', deepResearch: false },
			{ authored: 'Planning', deepResearch: false },
			{ authored: 'Verification', deepResearch: false },
			{ authored: 'Approval', deepResearch: false }
		];
	}
	if (job.job_type === 'audit') {
		const n = Math.max(1, Math.min(job.audit_num_runs ?? 3, MAX_AUDIT_RUNS));
		const prompt = job.steps[0]?.prompt ?? '';
		const samples: PlannedStep[] = Array.from({ length: n }, () => ({
			authored: prompt,
			deepResearch: false
		}));
		// Synthesis (cluster → verify → report) is deterministic; this text is
		// only the step's display label, not a model prompt.
		return [...samples, { authored: DEFAULT_AUDIT_SYNTHESIS_PROMPT, deepResearch: false }];
	}
	return job.steps.map((s) => ({ authored: s.prompt, deepResearch: s.deep_research }));
}

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
	// guided_planning jobs carry no authored steps — the run is driven by the
	// initial description + interactive Q&A, not a step pipeline.
	if (job.job_type !== 'guided_planning' && job.steps.length === 0) {
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
	const isAudit = job.job_type === 'audit';
	current = {
		id: runId,
		jobId: job.id,
		jobName: job.name,
		jobType: job.job_type,
		steps: planned.map((s, i) => ({
			index: i,
			promptAuthored: s.authored,
			// Audit steps render their prompt at execution time (sample wrapping /
			// synthesis); research step 0 has no prepend so it renders as-authored.
			promptRendered: !isAudit && i === 0 ? s.authored : '',
			deepResearch: s.deepResearch,
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
	const visionSupported = jobVisionSupported(job);
	const startedAt = Date.now();

	const contextSize = jobContextSize(job);
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

	try {
		const { finalText } = await runJobTurn(job, runId, abort, {
			userMessage: rendered,
			contextSize,
			deepResearch: step.deep_research,
			visionSupported,
			...callbacks
		});
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
	if (job.job_type === 'guided_planning') {
		return runGuidedPlanningPipeline(job, abort, runId);
	}
	if (job.job_type === 'audit') {
		return runAuditPipeline(job, abort, runId);
	}
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

/**
 * Tools a guided_planning run may use: read-only codebase grounding, the single
 * markdown write tool, and the interactive question tool. No code-editing,
 * exec, sandbox, email, or web-write tools — planning writes markdown only.
 */
const GUIDED_PLANNING_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'fs_read_pdf',
	'code_grep',
	'code_glob',
	'fs_write_text',
	'ask_user_question'
];

/**
 * Outline turn (stage 2a): read-only grounding + the question tool + the
 * structured outline tool. No fs_write_text — the outline turn enumerates the
 * phases, it does not write the files (that's the per-phase write loop).
 */
const OUTLINE_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'fs_read_pdf',
	'code_grep',
	'code_glob',
	'ask_user_question',
	SUBMIT_PLAN_OUTLINE_TOOL
];

/** A job's plan output folder, relative to working_dir (default plan/<slug>/). */
function guidedPlanOutputDir(job: JobWithSteps): string {
	const dir = job.plan_output_dir?.trim();
	if (dir) return dir;
	const slug =
		job.name
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'plan';
	return `plan/${slug}/`;
}

/**
 * Stage 1 (overview) system prompt: exhaustive, one-at-a-time, codebase-grounded
 * questioning via the question tool, then write overview.md from a fixed
 * template with a Decisions appendix. Planning only.
 */
function overviewStagePrompt(outDir: string, overviewPath: string): string {
	return [
		'You are running an interactive guided-planning session. This is STAGE 1 of',
		'2: produce a project OVERVIEW. Planning only — never write or edit code.',
		'',
		'HOW TO ASK THE USER ANYTHING (critical):',
		'The ONLY way to ask the user is to CALL the `ask_user_question` tool with a',
		'`question` string and an `options` array of {label, description}. The user',
		'cannot answer prose — if you write a question, or its options, as text it is',
		'discarded and the session stalls. Ask EXACTLY ONE question per tool call.',
		'',
		'Process:',
		'1. If this is an existing project, briefly ground yourself in the working',
		'   directory (fs_list_dir, fs_read_text, code_grep) so your questions and',
		'   the overview fit the real code.',
		'2. Interview the user ONE question at a time with `ask_user_question`,',
		'   resolving every decision needed for a complete overview: the problem,',
		'   goals, non-goals, the primary user flow, key constraints, and success',
		'   criteria. Offer 2–4 concrete options each time (the user can also type',
		'   their own answer). Keep going until the overview is fully specified. If',
		'   the user answers "proceed", "that\'s enough", or similar, stop asking',
		'   immediately and write the overview from what you have.',
		`3. Write the overview to \`${overviewPath}\` with fs_write_text, using these`,
		'   sections exactly: a top "# <Project> — Project Overview" heading, then',
		'   ## Problem, ## Goals, ## Non-goals, ## Users & primary flow,',
		'   ## Constraints, ## Success criteria, and finally ## Decisions — a list of',
		'   each question you asked and the answer the user chose. Write ONLY inside',
		`   \`${outDir}\` — never elsewhere, never code.`,
		'4. Send a one-line summary naming the file you wrote, then stop. Do NOT start',
		'   the implementation plan — that is stage 2, after the user reviews this.'
	].join('\n');
}

/** Revise the already-written overview per the user's request (checkpoint loop). */
function overviewRevisePrompt(outDir: string, overviewPath: string): string {
	return [
		'You are revising the project overview you already wrote. Planning only —',
		'never write or edit code.',
		'',
		`1. Read the current overview with fs_read_text from \`${overviewPath}\`.`,
		'2. Apply the change the user asked for (in the user message). Keep the rest',
		'   of the overview intact, and keep the same section structure.',
		`3. Write the updated overview back to \`${overviewPath}\` with fs_write_text.`,
		`   Write ONLY inside \`${outDir}\`.`,
		'4. Send a one-line summary of what you changed, then stop.',
		'If you must clarify the request, ask ONE question with the `ask_user_question`',
		'tool — never as plain text.'
	].join('\n');
}

/** Read-only toolset for the independent verifier (no write, no questions). */
const VERIFIER_TOOLS = ['fs_read_text', 'fs_list_dir', 'fs_read_pdf', 'code_grep', 'code_glob'];

/** Max verifier→revise rounds before proceeding to approval regardless. */
const MAX_VERIFY_ROUNDS = 3;

/**
 * Stage 2a (outline) system prompt: read the approved overview, resolve every
 * implementation decision via one-at-a-time questions, then report the COMPLETE
 * dependency-ordered phase list via `submit_plan_outline`. Writes no files — the
 * per-phase write loop (stage 2b) produces the markdown one file per turn, which
 * is how a small model reliably writes every phase instead of just the first.
 */
function outlineStagePrompt(outDir: string, overviewPath: string): string {
	return [
		'You are running an interactive guided-planning session. This is STAGE 2 of 2,',
		'part A: produce the OUTLINE of a phased implementation plan from the approved',
		'overview. Planning only — never write or edit code, and do NOT write any files',
		'in this step.',
		'',
		'HOW TO ASK THE USER ANYTHING (critical):',
		'The ONLY way to ask is to CALL `ask_user_question` (a `question` string + an',
		'`options` array). Text questions are discarded. Ask EXACTLY ONE per call.',
		'',
		'Process:',
		`1. Read the approved overview from \`${overviewPath}\`, and ground yourself in`,
		'   the working directory (fs_list_dir, fs_read_text, code_grep) so the plan',
		'   fits the real code — correct file paths, existing patterns, real deps.',
		'2. Resolve EVERY remaining implementation decision by asking the user ONE',
		'   question at a time with `ask_user_question`. Do not defer decisions — if a',
		'   choice is unresolved, ask it. If the user answers "proceed", stop asking.',
		'3. Break the WHOLE project into phases ordered STRICTLY by dependency: every',
		'   phase may depend ONLY on earlier phases, never a later one. Cover the',
		'   project end to end — most plans need several phases, not one.',
		'4. Report the outline by calling `submit_plan_outline` exactly once, with',
		'   every phase (id "01", "02", …; title; depends_on; a 1–3 sentence summary).',
		'   Do NOT write any phase files — that happens next, one phase at a time.'
	].join('\n');
}

/** Re-run the outline turn after the user asks for a change at the checkpoint. */
function outlineRevisePrompt(overviewPath: string): string {
	return [
		'You are revising the implementation-plan OUTLINE. Planning only — write no',
		'files, edit no code.',
		'',
		`1. Re-read the overview at \`${overviewPath}\` if helpful.`,
		'2. Apply the change the user asked for, keeping STRICT dependency order and',
		'   full end-to-end project coverage.',
		'3. Call `submit_plan_outline` exactly once with the COMPLETE revised phase',
		'   list — every phase, not just the ones that changed.'
	].join('\n');
}

/**
 * Stage 2b (per-phase write) system prompt: write EXACTLY ONE phase file from
 * the approved outline. The runner drives one of these per phase, so the model
 * only ever has to do a single thing — write one file — rather than "write them
 * all", which a small model tends to abandon after the first.
 */
function phaseWritePrompt(outDir: string, overviewPath: string): string {
	return [
		'You are writing ONE file of an approved, dependency-ordered implementation',
		'plan. Planning only — never write or edit code. Every decision is already',
		'made: do NOT ask questions, just write the one file you are told to write.',
		'',
		`Read the overview at \`${overviewPath}\` and any earlier phase files in`,
		`\`${outDir}\` for context (fs_read_text, fs_list_dir). Then write EXACTLY the`,
		'single phase file named in the instruction, with fs_write_text, using these',
		'sections: a "# Phase NN — <title>" heading, a "Depends on:" / "Enables:" line,',
		'then ## Goal, ## Files touched, ## Steps, ## Build gate, ## Test plan,',
		'## Commit, ## Rollback. Resolve every decision in the text — never "TBD" or',
		`"decide later". Write ONLY that one file, inside \`${outDir}\`. Then stop.`
	].join('\n');
}

/**
 * Independent verifier system prompt. Fresh context (it reads the artifacts from
 * disk, never the planning conversation), read-only, single job: flag ordering
 * violations and deferred decisions. Signals "PLAN OK" when clean.
 */
function verifierPrompt(outDir: string, overviewPath: string): string {
	return [
		'You are an INDEPENDENT reviewer of a phased implementation plan. You did not',
		'write it. Review it with fresh eyes and check ONLY two things.',
		'',
		`1. Read the overview at \`${overviewPath}\`, then list \`${outDir}\` and read`,
		'   every phase-NN-*.md file in it.',
		'2. Look for exactly two kinds of problem:',
		'   a. ORDERING — any phase that depends on work introduced in a LATER phase',
		'      (its "Depends on" names a higher-numbered phase, or its steps need',
		'      something a later phase creates).',
		'   b. DEFERRED DECISIONS — any "TBD", "decide later", "we’ll figure out", an',
		'      unresolved either/or, or a step that does not say what to actually do.',
		'',
		'You write NOTHING to disk. Then respond:',
		'- If there are NO problems, your ENTIRE reply must be exactly: PLAN OK',
		'- Otherwise, reply with a short bulleted list — each bullet naming the phase',
		'  file and the specific ordering/decision problem to fix.',
		'Report only ordering violations and unresolved decisions — not style or',
		'scope opinions.'
	].join('\n');
}

/** Revise the phase files per reviewer findings or a user request (checkpoint). */
function planRevisePrompt(outDir: string): string {
	return [
		'You are revising the phased implementation plan. Planning only — never write',
		'or edit code.',
		'',
		`1. Read the relevant phase files in \`${outDir}\` (fs_list_dir, fs_read_text).`,
		'2. Apply the fixes requested in the user message. Preserve STRICT dependency',
		'   order (every phase depends only on earlier phases) and resolve every',
		'   decision — no "TBD"/"decide later". Keep the same section structure.',
		`3. Write the corrected phase files back with fs_write_text (only inside`,
		`   \`${outDir}\`). If a fix changes ordering, renumber the files so NN still`,
		'   reflects dependency order.',
		'4. Send a one-line summary of what you changed, then stop.'
	].join('\n');
}

/** The verifier reports a clean plan by replying with "PLAN OK". */
function isPlanClean(verdict: string): boolean {
	return verdict.trim().toUpperCase().startsWith('PLAN OK');
}

/**
 * Guided-planning run. Stage 1 (overview): a codebase-grounded interactive
 * interview writes overview.md, then a review checkpoint (approve / type a
 * revision / re-read after a manual edit) loops until approved. Stage 2a
 * (outline): an interview produces a structured, dependency-ordered phase list
 * via submit_plan_outline, gated by a dep-map approval checkpoint. Stage 2b
 * (planning): the runner writes the phase files ONE PER TURN from the approved
 * outline — a small model abandons "write them all" after the first file, so
 * each phase is its own focused, on-disk-verified write. An independent
 * fresh-context verifier then flags ordering violations and deferred decisions
 * and drives revisions until clean, and a final plan-approval checkpoint loops
 * until approved.
 *
 * Milestone-persisted needs-input/resume is a later hardening pass — a
 * foreground run completes fully; a killed run does not yet resume.
 */
async function runGuidedPlanningPipeline(
	job: JobWithSteps,
	abort: AbortController,
	runId: number
): Promise<void> {
	void markRunStarted(runId, Date.now());
	const outDir = guidedPlanOutputDir(job);
	const overviewPath = `${outDir}overview.md`;

	// Step indices — must match the guided_planning display steps in planSteps.
	const OVERVIEW = 0;
	const OUTLINE = 1;
	const PLANNING = 2;
	const VERIFY = 3;
	const APPROVAL = 4;

	const startStep = (idx: number) => {
		const startedAt = Date.now();
		patchStep(runId, idx, { status: 'running', startedAt });
		if (current && current.id === runId) current = { ...current, currentStepIndex: idx };
		void markRunStepStarted(runId, idx, startedAt, current?.steps[idx]?.promptAuthored ?? '');
	};
	const finishStep = (idx: number, output: string) => {
		const finishedAt = Date.now();
		patchStep(runId, idx, { status: 'succeeded', output, finishedAt });
		void markRunStepFinished(runId, idx, 'succeeded', output, null, finishedAt);
	};

	const turn = (
		stepIdx: number,
		userMessage: string,
		systemPrompt: string,
		maxIterations: number,
		// `expectsFileOutput` arms the in-turn file-write hallucination guard so the
		// model self-corrects WITHIN the turn (cheaper than the post-turn
		// `ensureWritten` retry). Set it on the turns whose job is to produce a file;
		// leave it off for the read-only verifier turn.
		opts: { tools?: string[]; expectsFileOutput?: boolean } = {}
	) =>
		runJobTurn(job, runId, abort, {
			userMessage,
			contextSize: jobContextSize(job),
			visionSupported: jobVisionSupported(job),
			maxIterations,
			interactive: true,
			writeRoot: outDir,
			systemPrompt,
			toolAllowlist: opts.tools ?? GUIDED_PLANNING_TOOLS,
			expectsFileOutput: opts.expectsFileOutput,
			...buildStreamCallbacks(runId, stepIdx)
		});

	const abortIfCancelled = () => {
		if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
	};

	// Backstop for a model (especially a small one like the 9B default) that
	// narrates "I wrote the file" without actually emitting an fs_write_text call.
	// We verify the expected output on disk and, if it's missing, give the model a
	// pointed retry BEFORE the user ever reaches a checkpoint — so the runner never
	// claims a file it can't see, and never asks the user to approve a phantom plan.
	const MAX_WRITE_ATTEMPTS = 3;

	const fileExists = async (relPath: string): Promise<boolean> => {
		// No sandbox root → can't verify (and writes need one anyway); don't block.
		if (!job.working_dir) return true;
		try {
			return await invoke<boolean>('fs_path_exists', {
				workdir: job.working_dir,
				relPath
			});
		} catch {
			return false;
		}
	};

	// Verify `exists()`; if not, re-prompt the model to actually write (bounded),
	// then throw a clear, honest error if the file still never lands.
	const ensureWritten = async (
		exists: () => Promise<boolean>,
		stepIdx: number,
		retryMessage: string,
		retryPrompt: string,
		missingError: string
	): Promise<void> => {
		for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
			abortIfCancelled();
			if (await exists()) return;
			await turn(stepIdx, retryMessage, retryPrompt, 15, { expectsFileOutput: true });
		}
		abortIfCancelled();
		if (!(await exists())) throw new Error(missingError);
	};

	// Independent verifier (shown on the Verification step); revise once if it
	// reports problems. Returns true when the plan is clean.
	const verifyOnce = async (): Promise<boolean> => {
		const verdict = await turn(
			VERIFY,
			`Review the phase files in ${outDir} against ${overviewPath}.`,
			verifierPrompt(outDir, overviewPath),
			25,
			{ tools: VERIFIER_TOOLS }
		);
		if (isPlanClean(verdict.finalText)) return true;
		await turn(
			VERIFY,
			`A reviewer found problems with the phase files. Fix every one, keeping ` +
				`strict dependency order:\n\n${verdict.finalText}`,
			planRevisePrompt(outDir),
			35,
			{ expectsFileOutput: true }
		);
		return false;
	};

	// One normalized phase from the approved outline: the runner controls the NN
	// numbering and filename (never the model), so the per-phase write target is
	// deterministic and verifiable.
	interface NormalizedPhase {
		nn: string;
		title: string;
		relPath: string;
		dependsOn: string[];
		summary: string;
	}

	const slugify = (s: string): string =>
		s
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'phase';

	// Number phases by position (the outline is dependency-ordered) rather than
	// trusting the model's ids, then resolve each `depends_on` id to its NN.
	const normalizeOutline = (raw: PlanOutlinePhaseArg[]): NormalizedPhase[] => {
		// Plain object (not a Map) — a transient lookup, not reactive state.
		const idToNn: Record<string, string> = {};
		raw.forEach((p, i) => {
			const id = typeof p?.id === 'string' ? p.id.trim() : '';
			if (id) idToNn[id] = String(i + 1).padStart(2, '0');
		});
		return raw.map((p, i) => {
			const nn = String(i + 1).padStart(2, '0');
			const title = (typeof p?.title === 'string' && p.title.trim()) || `Phase ${nn}`;
			const dependsOn = Array.isArray(p?.depends_on)
				? p.depends_on
						.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
						.map((d) => idToNn[d.trim()] ?? d.trim())
				: [];
			return {
				nn,
				title,
				relPath: `${outDir}phase-${nn}-${slugify(title)}.md`,
				dependsOn,
				summary: typeof p?.summary === 'string' ? p.summary.trim() : ''
			};
		});
	};

	const renderOutline = (phases: NormalizedPhase[]): string =>
		phases
			.map(
				(p) =>
					`Phase ${p.nn} — ${p.title}` +
					(p.dependsOn.length ? ` (depends on ${p.dependsOn.join(', ')})` : '') +
					(p.summary ? `: ${p.summary}` : '')
			)
			.join('\n');

	// Outline turn: interview + ground + `submit_plan_outline`. The phase list is
	// captured off the tool-call stream (the executor just acks); the call is
	// FORCED so a model that interviews but forgets to submit still yields one.
	const runOutlineTurn = async (
		userMessage: string,
		systemPrompt: string
	): Promise<PlanOutlinePhaseArg[]> => {
		let captured: PlanOutlinePhaseArg[] = [];
		const base = buildStreamCallbacks(runId, OUTLINE);
		await runJobTurn(job, runId, abort, {
			userMessage,
			contextSize: jobContextSize(job),
			visionSupported: jobVisionSupported(job),
			maxIterations: 40,
			interactive: true,
			writeRoot: outDir,
			systemPrompt,
			toolAllowlist: OUTLINE_TOOLS,
			forceFinalTool: SUBMIT_PLAN_OUTLINE_TOOL,
			...base,
			onToolStart: (call: ResolvedToolCall) => {
				if (call.name === SUBMIT_PLAN_OUTLINE_TOOL && Array.isArray(call.arguments?.phases)) {
					captured = call.arguments.phases as PlanOutlinePhaseArg[];
				}
				base.onToolStart(call);
			}
		});
		return captured;
	};

	// Run the outline turn, retrying (bounded) if the model never submits a phase
	// list. Throws honestly if it never does, rather than proceeding with zero
	// phases — the model is then too small for this job.
	const obtainOutline = async (
		userMessage: string,
		systemPrompt: string
	): Promise<NormalizedPhase[]> => {
		let msg = userMessage;
		let prompt = systemPrompt;
		for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
			abortIfCancelled();
			const phases = normalizeOutline(await runOutlineTurn(msg, prompt));
			if (phases.length > 0) return phases;
			msg =
				`You did not call submit_plan_outline, so no phases were recorded. Call it ` +
				`now with the COMPLETE dependency-ordered phase list for the whole project.`;
			prompt = outlineRevisePrompt(overviewPath);
		}
		throw new Error(
			`The model never produced a plan outline (no submit_plan_outline call) after ` +
				`${MAX_WRITE_ATTEMPTS} attempts. The selected model may be too small for guided ` +
				`planning — try a larger model.`
		);
	};

	try {
		// Stage 1 — Overview: interview + write, then the review checkpoint loop.
		startStep(OVERVIEW);
		await turn(
			OVERVIEW,
			job.initial_description?.trim() || 'Plan this project.',
			overviewStagePrompt(outDir, overviewPath),
			40,
			{ expectsFileOutput: true }
		);
		await ensureWritten(
			() => fileExists(overviewPath),
			OVERVIEW,
			`I don't see ${overviewPath} on disk yet — you may have described writing the ` +
				`overview without actually calling the fs_write_text tool. Do NOT ask any more ` +
				`questions; call fs_write_text now to write the overview to ${overviewPath}, then stop.`,
			overviewStagePrompt(outDir, overviewPath),
			`The overview was never written to ${overviewPath} after ${MAX_WRITE_ATTEMPTS} attempts. ` +
				`The selected model may be too small to follow the write step reliably — try a larger model.`
		);
		let approved = false;
		while (!approved) {
			abortIfCancelled();
			const answer = await askUserQuestion(
				{
					question:
						`I wrote the project overview to ${overviewPath}. Review it, then approve ` +
						`to continue — or type what you'd like changed and I'll revise it.`,
					options: [
						{ label: 'Approve', description: 'The overview looks good.', recommended: true },
						{
							label: 'I edited it myself — re-read',
							description: 'I changed the file on disk; re-read it before asking again.'
						}
					]
				},
				abort.signal
			);
			abortIfCancelled();
			if (answer.kind === 'selected' && answer.labels[0] === 'Approve') {
				approved = true;
			} else if (answer.kind === 'freeText') {
				await turn(
					OVERVIEW,
					`Please revise the overview. The user asked for: ${answer.text}`,
					overviewRevisePrompt(outDir, overviewPath),
					20,
					{ expectsFileOutput: true }
				);
			}
		}
		finishStep(OVERVIEW, `Overview approved → ${overviewPath}`);

		// Stage 2a — Outline: interview + structured phase list, then the dep-map
		// approval checkpoint. The outline is what makes the per-phase write loop
		// completeness-checkable: the runner knows exactly how many files to demand.
		startStep(OUTLINE);
		let outline = await obtainOutline(
			`The overview at ${overviewPath} is approved. Now design the phased plan OUTLINE.`,
			outlineStagePrompt(outDir, overviewPath)
		);
		let outlineApproved = false;
		while (!outlineApproved) {
			abortIfCancelled();
			const answer = await askUserQuestion(
				{
					question:
						`Here's the plan outline — ${outline.length} phase(s), in dependency order:\n\n` +
						`${renderOutline(outline)}\n\n` +
						`Approve to write the phase files, or type what you'd like changed.`,
					options: [
						{
							label: 'Approve',
							description: 'The phase breakdown looks good — write the files.',
							recommended: true
						}
					]
				},
				abort.signal
			);
			abortIfCancelled();
			if (answer.kind === 'selected' && answer.labels[0] === 'Approve') {
				outlineApproved = true;
			} else if (answer.kind === 'freeText') {
				outline = await obtainOutline(
					`Please revise the outline. The user asked for: ${answer.text}`,
					outlineRevisePrompt(overviewPath)
				);
			}
		}
		finishStep(OUTLINE, `Outline approved — ${outline.length} phase(s)`);

		// Stage 2b — Planning: write the phase files ONE PER TURN. A small model
		// asked to "write all the files" reliably writes the first and stops; driving
		// one focused write per phase (each verified on disk) is what gets a complete
		// plan out of it. The shared outline goes in as context so deps line up.
		startStep(PLANNING);
		const outlineText = renderOutline(outline);
		for (const phase of outline) {
			abortIfCancelled();
			patchStep(runId, PLANNING, { streaming: `Writing phase ${phase.nn} — ${phase.title}` });
			const writeMsg =
				`Full plan outline (for context — you are writing only ONE of these):\n` +
				`${outlineText}\n\n` +
				`Now write ONLY Phase ${phase.nn} — ${phase.title} to \`${phase.relPath}\`. ` +
				(phase.dependsOn.length ? `It depends on phase ${phase.dependsOn.join(', ')}. ` : '') +
				(phase.summary ? `Scope: ${phase.summary}` : '');
			await turn(PLANNING, writeMsg, phaseWritePrompt(outDir, overviewPath), 30, {
				expectsFileOutput: true
			});
			await ensureWritten(
				() => fileExists(phase.relPath),
				PLANNING,
				`I don't see ${phase.relPath} on disk yet — you may have described writing it ` +
					`without calling fs_write_text. Do NOT ask questions; write Phase ${phase.nn} to ` +
					`${phase.relPath} now with fs_write_text, then stop.`,
				phaseWritePrompt(outDir, overviewPath),
				`Phase ${phase.nn} (${phase.relPath}) was never written after ${MAX_WRITE_ATTEMPTS} ` +
					`attempts. The selected model may be too small to follow the write step reliably — ` +
					`try a larger model.`
			);
		}
		finishStep(PLANNING, `Wrote ${outline.length} phase file(s) to ${outDir}`);

		// Verification — independent fresh-context review, revise until clean (bounded).
		startStep(VERIFY);
		for (let round = 0; round < MAX_VERIFY_ROUNDS; round++) {
			abortIfCancelled();
			if (await verifyOnce()) break;
		}
		finishStep(VERIFY, 'Plan verified — dependency-ordered, no deferred decisions');

		// Approval — plan / dependency-map approval checkpoint loop.
		startStep(APPROVAL);
		let planApproved = false;
		while (!planApproved) {
			abortIfCancelled();
			const answer = await askUserQuestion(
				{
					question:
						`I wrote the phased implementation plan to ${outDir} (phase-NN-*.md), ` +
						`ordered by dependency and checked for unresolved decisions. Review it, ` +
						`then approve — or type what you'd like changed.`,
					options: [
						{ label: 'Approve', description: 'The plan looks good — finish.', recommended: true },
						{
							label: 'I edited it myself — re-check',
							description: 'I changed files on disk; re-read them before asking again.'
						}
					]
				},
				abort.signal
			);
			abortIfCancelled();
			if (answer.kind === 'selected' && answer.labels[0] === 'Approve') {
				planApproved = true;
			} else if (answer.kind === 'freeText') {
				await turn(
					APPROVAL,
					`Please revise the phased plan. The user asked for: ${answer.text}`,
					planRevisePrompt(outDir),
					30,
					{ expectsFileOutput: true }
				);
				await verifyOnce(); // re-check after a user-driven revision
			}
		}
		finishStep(APPROVAL, `Plan approved → ${outDir}`);

		finalizeRun(runId, job.id, 'succeeded', null);
	} catch (e) {
		const aborted = e instanceof DOMException && e.name === 'AbortError';
		const msg = aborted ? 'Cancelled by user' : errMessage(e);
		const stepStatus: JobRunStepStatus = aborted ? 'cancelled' : 'failed';
		const finishedAt = Date.now();
		// Mark whichever stage was live when the error/cancel hit.
		const idx = current && current.id === runId ? current.currentStepIndex : 0;
		patchStep(runId, idx, { status: stepStatus, error: msg, finishedAt });
		void markRunStepFinished(runId, idx, stepStatus, null, msg, finishedAt);
		finalizeRun(runId, job.id, aborted ? 'cancelled' : 'failed', msg);
	} finally {
		if (activeAbort === abort) activeAbort = null;
		if (pending.length > 0) queueMicrotask(drainNext);
	}
}

/**
 * Audit run: execute N independent sample steps (each capturing structured
 * findings), then a synthesis step that clusters, source-verifies, and reports.
 * Step failure/cancellation is marked once, centrally, on whichever step was
 * live (tracked via currentStepIndex) when the error propagated.
 */
async function runAuditPipeline(
	job: JobWithSteps,
	abort: AbortController,
	runId: number
): Promise<void> {
	void markRunStarted(runId, Date.now());
	const planned = planSteps(job);
	const synthesisIndex = planned.length - 1;
	const numRuns = synthesisIndex; // every step but the last is a sample
	const auditPrompt = job.steps[0]?.prompt ?? '';

	try {
		const result = await orchestrateAudit({
			numRuns,
			jobName: job.name,
			signal: abort.signal,
			runSample: (i) => runAuditSampleStep(job, runId, i, auditPrompt, abort),
			beginSynthesis: () => {
				const startedAt = Date.now();
				if (current && current.id === runId) {
					current = { ...current, currentStepIndex: synthesisIndex };
				}
				patchStep(runId, synthesisIndex, {
					status: 'running',
					promptRendered: planned[synthesisIndex].authored,
					startedAt
				});
				void markRunStepStarted(runId, synthesisIndex, startedAt, planned[synthesisIndex].authored);
			},
			verifyCluster: (cluster, idx, total) =>
				verifyClusterTurn(job, runId, synthesisIndex, cluster, idx, total, abort)
		});

		// Write the report to the configured file (best-effort; failure is noted
		// in the step output but doesn't fail the run — the report is also saved
		// to the step itself).
		let note = '';
		if (job.audit_output_file && job.working_dir) {
			try {
				await invoke('fs_write_text', {
					workdir: job.working_dir,
					relPath: job.audit_output_file,
					content: result.report,
					overwrite: true
				});
				note = `\n\n_Report written to ${job.audit_output_file}._`;
			} catch (e) {
				note = `\n\n_Could not write ${job.audit_output_file}: ${errMessage(e)}_`;
			}
		}

		const finishedAt = Date.now();
		const output = result.report + note;
		patchStep(runId, synthesisIndex, { status: 'succeeded', output, finishedAt });
		void markRunStepFinished(runId, synthesisIndex, 'succeeded', output, null, finishedAt);
		finalizeRun(runId, job.id, 'succeeded', null);
	} catch (e) {
		const aborted = e instanceof DOMException && e.name === 'AbortError';
		const msg = aborted ? 'Cancelled by user' : errMessage(e);
		const status: RunStatus = aborted ? 'cancelled' : 'failed';
		const stepStatus: JobRunStepStatus = aborted ? 'cancelled' : 'failed';
		const liveStep = current?.id === runId ? current.currentStepIndex : 0;
		const finishedAt = Date.now();
		patchStep(runId, liveStep, { status: stepStatus, error: msg, finishedAt });
		void markRunStepFinished(runId, liveStep, stepStatus, null, msg, finishedAt);
		finalizeRun(runId, job.id, status, msg);
	} finally {
		if (activeAbort === abort) activeAbort = null;
		if (pending.length > 0) queueMicrotask(drainNext);
	}
}

/** Run one audit sample, returning the findings it submitted. Throws on failure. */
async function runAuditSampleStep(
	job: JobWithSteps,
	runId: number,
	stepIndex: number,
	auditPrompt: string,
	abort: AbortController
): Promise<AuditFinding[]> {
	const startedAt = Date.now();
	const rendered = buildSamplePrompt(auditPrompt, job.audit_sample_instructions);
	if (current && current.id === runId) {
		current = { ...current, currentStepIndex: stepIndex };
	}
	patchStep(runId, stepIndex, { status: 'running', promptRendered: rendered, startedAt });
	void markRunStepStarted(runId, stepIndex, startedAt, rendered);

	// Capture the submit_findings arguments off the tool-call stream.
	let captured: AuditFinding[] = [];
	const base = buildStreamCallbacks(runId, stepIndex);
	const callbacks = {
		...base,
		onToolStart: (call: ResolvedToolCall) => {
			if (call.name === SUBMIT_FINDINGS_TOOL && Array.isArray(call.arguments?.findings)) {
				captured = call.arguments.findings as AuditFinding[];
			}
			base.onToolStart(call);
		}
	};

	const { finalText } = await runJobTurn(job, runId, abort, {
		userMessage: rendered,
		contextSize: jobContextSize(job),
		visionSupported: jobVisionSupported(job),
		toolAllowlist: SAMPLE_ALLOW,
		// Guarantee the run records structured findings: if the model burns its
		// whole budget exploring and never submits, force the submit_findings
		// call rather than discarding a prose answer.
		forceFinalTool: SUBMIT_FINDINGS_TOOL,
		maxIterations: auditSampleIterations(job),
		...callbacks
	});

	const finishedAt = Date.now();
	const output =
		`**${captured.length} finding(s)**\n\n` +
		`\`\`\`json\n${JSON.stringify(captured, null, 2)}\n\`\`\`` +
		(finalText.trim() ? `\n\n${finalText.trim()}` : '');
	patchStep(runId, stepIndex, { status: 'succeeded', output, finishedAt });
	void markRunStepFinished(runId, stepIndex, 'succeeded', output, null, finishedAt);
	return captured;
}

/** Verify one cluster against source via a read-only submit_verdict turn. */
async function verifyClusterTurn(
	job: JobWithSteps,
	runId: number,
	synthesisIndex: number,
	cluster: FindingCluster,
	idx: number,
	total: number,
	abort: AbortController
): Promise<{ verdict: AuditVerdict; evidence: string | null; location: string | null }> {
	patchStep(runId, synthesisIndex, {
		streaming: `Verifying ${idx + 1}/${total}: ${cluster.title}`
	});

	let verdict: AuditVerdict = 'uncertain';
	let evidence: string | null = null;
	let location: string | null = null;
	const onToolStart = (call: ResolvedToolCall) => {
		if (call.name !== SUBMIT_VERDICT_TOOL) return;
		const v = call.arguments?.verdict;
		if (v === 'confirmed' || v === 'refuted' || v === 'uncertain') verdict = v;
		if (typeof call.arguments?.evidence === 'string') evidence = call.arguments.evidence;
		if (typeof call.arguments?.location === 'string' && call.arguments.location.trim())
			location = call.arguments.location.trim();
	};

	await runJobTurn(job, runId, abort, {
		userMessage: buildVerifyPrompt(cluster, job.audit_verify_instructions),
		contextSize: jobContextSize(job),
		visionSupported: jobVisionSupported(job),
		toolAllowlist: VERIFY_ALLOW,
		forceFinalTool: SUBMIT_VERDICT_TOOL,
		maxIterations: AUDIT_VERIFY_MAX_ITERATIONS,
		onToolStart
	});
	return { verdict, evidence, location };
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
