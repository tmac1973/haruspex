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
import { getActiveContextSize, isVisionSupported } from '$lib/stores/settings';
import { GUIDED_PLANNING_STAGES, runGuidedPlanningPipeline } from './guided-planning/pipeline';
import { markStepDone, newRunningStep } from '$lib/agent/steps';
import { errMessage, normalizeAbort } from '$lib/utils/error';
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
		// in the process it is. Stage indices in the pipeline must match.
		return GUIDED_PLANNING_STAGES.map((stage) => ({ authored: stage, deepResearch: false }));
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
		const { aborted, msg } = normalizeAbort(e);
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
		// Explicit deps object (rough draft of the Phase 02 JobRunContext): the
		// pipeline gets run-scoped capabilities, never the runner's module state.
		return runGuidedPlanningPipeline({
			job,
			runId,
			abort,
			runJobTurn: (opts) => runJobTurn(job, runId, abort, opts),
			patchStep: (stepIndex, patch) => patchStep(runId, stepIndex, patch),
			buildStreamCallbacks: (stepIndex) => buildStreamCallbacks(runId, stepIndex),
			setCurrentStepIndex: (stepIndex) => {
				if (current && current.id === runId) current = { ...current, currentStepIndex: stepIndex };
			},
			liveStepIndex: () => (current && current.id === runId ? current.currentStepIndex : 0),
			stepAuthored: (stepIndex) => current?.steps[stepIndex]?.promptAuthored ?? '',
			contextSize: () => jobContextSize(job),
			visionSupported: () => jobVisionSupported(job),
			finalizeRun: (status, error) => finalizeRun(runId, job.id, status, error),
			onSettled: () => {
				if (activeAbort === abort) activeAbort = null;
				if (pending.length > 0) queueMicrotask(drainNext);
			}
		});
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
		const { aborted, msg } = normalizeAbort(e);
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
