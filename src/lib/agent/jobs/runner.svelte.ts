/**
 * Multi-step job runner.
 *
 * Scope for phase-14 step 4: walks all steps in a job, prepending the
 * previous step's output to each subsequent step's prompt. On first
 * failure the run halts; remaining steps stay `pending`. No queue, no DB
 * persistence yet (those land in steps 5 + 7 of the plan).
 *
 * The UI subscribes to `getCurrentRun()` and reads `currentStepIndex`
 * to know which step is live.
 */

import type { ResolvedToolCall } from '$lib/agent/parser';
import type { Artifact } from '$lib/agent/tools';
import type { SearchStep } from '$lib/agent/loop';
import { runEphemeralTurn } from '$lib/agent/runEphemeralTurn';
import { runWithAutoApprove } from '$lib/stores/approvalOverride';
import { getJob, type JobWithSteps } from '$lib/stores/jobs.svelte';
import { getActiveContextSize, getSettings } from '$lib/stores/settings';
import { getDisplayLabel } from '$lib/agent/tools';
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
	startedAt: number | null;
	finishedAt: number | null;
}

export interface RunState {
	/** Local id — not yet persisted, so a monotonic counter. */
	id: number;
	jobId: number;
	jobName: string;
	steps: RunStepState[];
	currentStepIndex: number;
	status: RunStatus;
	error: string | null;
	startedAt: number;
	finishedAt: number | null;
}

let current = $state<RunState | null>(null);
let nextRunId = 1;
let activeAbort: AbortController | null = null;

export function getCurrentRun(): RunState | null {
	return current;
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
	if (current?.status === 'running') {
		logDebug('jobs', 'runner busy; ignoring enqueue', { jobId, trigger });
		return null;
	}

	const job = await getJob(jobId);
	if (!job) {
		logDebug('jobs', 'enqueue failed: job not found', { jobId, trigger });
		return null;
	}
	if (job.steps.length === 0) {
		logDebug('jobs', 'enqueue failed: no steps', { jobId });
		return null;
	}
	if (!job.working_dir) {
		logDebug('jobs', 'enqueue failed: no working dir', { jobId });
		return null;
	}

	const runId = nextRunId++;
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
			startedAt: null,
			finishedAt: null
		})),
		currentStepIndex: 0,
		status: 'running',
		error: null,
		startedAt: Date.now(),
		finishedAt: null
	};

	void runPipeline(job, abort, runId);
	return runId;
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
				searchSteps: [
					...step.searchSteps,
					{
						id: call.id,
						toolName: call.name,
						query: getDisplayLabel(call.name, call.arguments),
						status: 'running' as const,
						args: call.arguments
					}
				]
			});
		},
		onToolEnd: (
			call: ResolvedToolCall,
			result: string,
			thumbDataUrl?: string,
			artifacts?: Artifact[]
		) => {
			if (!current || current.id !== runId) return;
			const step = current.steps[stepIndex];
			if (!step) return;
			patchStep(runId, stepIndex, {
				searchSteps: step.searchSteps.map((s) =>
					s.id === call.id ? { ...s, status: 'done' as const, result, thumbDataUrl, artifacts } : s
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
	const backend = getSettings().inferenceBackend;
	const visionSupported =
		backend.mode === 'remote' ? backend.remoteVisionSupported !== false : true;

	patchStep(runId, stepIndex, {
		status: 'running',
		promptRendered: rendered,
		startedAt: Date.now()
	});
	if (current && current.id === runId) {
		current = { ...current, currentStepIndex: stepIndex };
	}

	const callbacks = buildStreamCallbacks(runId, stepIndex);
	const wrap = job.auto_approve_tools ? runWithAutoApprove : passthrough;

	try {
		const { finalText } = await wrap(() =>
			runEphemeralTurn({
				userMessage: rendered,
				workingDir: job.working_dir,
				contextSize: getActiveContextSize(),
				deepResearch: step.deep_research,
				visionSupported,
				signal: abort.signal,
				...callbacks
			})
		);
		patchStep(runId, stepIndex, {
			status: 'succeeded',
			output: finalText,
			finishedAt: Date.now()
		});
		return { ok: true, output: finalText };
	} catch (e) {
		const aborted = e instanceof DOMException && e.name === 'AbortError';
		const msg = aborted ? 'Cancelled by user' : e instanceof Error ? e.message : String(e);
		patchStep(runId, stepIndex, {
			status: aborted ? 'cancelled' : 'failed',
			error: msg,
			finishedAt: Date.now()
		});
		return { ok: false, aborted, error: msg };
	}
}

async function runPipeline(
	job: JobWithSteps,
	abort: AbortController,
	runId: number
): Promise<void> {
	let priorOutput = '';
	try {
		for (let i = 0; i < job.steps.length; i++) {
			if (!current || current.id !== runId) return;
			const authored = job.steps[i].prompt;
			const rendered = renderPrompt(i, authored, priorOutput);
			const result = await runOneStep(job, runId, i, rendered, abort);
			if (!result.ok) {
				finalizeRun(runId, {
					status: result.aborted ? 'cancelled' : 'failed',
					error: result.error
				});
				return;
			}
			priorOutput = result.output;
		}
		finalizeRun(runId, { status: 'succeeded' });
	} finally {
		if (activeAbort === abort) activeAbort = null;
	}
}

function finalizeRun(runId: number, patch: Partial<RunState>): void {
	if (!current || current.id !== runId) return;
	current = { ...current, ...patch, finishedAt: Date.now() };
}

function passthrough<T>(fn: () => Promise<T>): Promise<T> {
	return fn();
}

export function cancel(runId: number): void {
	if (!current || current.id !== runId) return;
	if (current.status !== 'running') return;
	activeAbort?.abort();
}
