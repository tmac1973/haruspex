/**
 * Single-job runner.
 *
 * Scope for phase-14 step 3: runs ONE step of ONE job at a time. No queue,
 * no multi-step pipeline (the runner only executes step 0 — the rest of
 * the step list is ignored until step 4 of the plan). No persistence to
 * job_runs / job_run_steps (that lands in step 5). State is purely
 * in-memory.
 *
 * The UI subscribes to `getCurrentRun()` to render the live run view and
 * calls `enqueue(jobId, 'manual')` from the Run button.
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

export interface RunState {
	/** Local id — not yet persisted, so a monotonic counter. */
	id: number;
	jobId: number;
	jobName: string;
	stepIndex: number;
	stepPrompt: string;
	deepResearch: boolean;
	streaming: string;
	finalText: string;
	status: RunStatus;
	error: string | null;
	searchSteps: SearchStep[];
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

	const step = job.steps[0];
	const runId = nextRunId++;
	const abort = new AbortController();
	activeAbort = abort;

	current = {
		id: runId,
		jobId: job.id,
		jobName: job.name,
		stepIndex: 0,
		stepPrompt: step.prompt,
		deepResearch: step.deep_research,
		streaming: '',
		finalText: '',
		status: 'running',
		error: null,
		searchSteps: [],
		startedAt: Date.now(),
		finishedAt: null
	};

	void runStep(job, abort);
	return runId;
}

function buildStreamCallbacks(runId: number) {
	return {
		onAssistantDelta: (full: string) => {
			if (!current || current.id !== runId) return;
			current = { ...current, streaming: full };
		},
		onToolStart: (call: ResolvedToolCall) => {
			if (!current || current.id !== runId) return;
			current = {
				...current,
				searchSteps: [
					...current.searchSteps,
					{
						id: call.id,
						toolName: call.name,
						query: getDisplayLabel(call.name, call.arguments),
						status: 'running' as const,
						args: call.arguments
					}
				]
			};
		},
		onToolEnd: (
			call: ResolvedToolCall,
			result: string,
			thumbDataUrl?: string,
			artifacts?: Artifact[]
		) => {
			if (!current || current.id !== runId) return;
			current = {
				...current,
				searchSteps: current.searchSteps.map((s) =>
					s.id === call.id ? { ...s, status: 'done' as const, result, thumbDataUrl, artifacts } : s
				)
			};
		}
	};
}

function finalizeRun(runId: number, patch: Partial<RunState>): void {
	if (!current || current.id !== runId) return;
	current = { ...current, ...patch, finishedAt: Date.now() };
}

async function runStep(job: JobWithSteps, abort: AbortController): Promise<void> {
	const step = job.steps[0];
	const backend = getSettings().inferenceBackend;
	const visionSupported =
		backend.mode === 'remote' ? backend.remoteVisionSupported !== false : true;
	const runId = current?.id ?? -1;
	const callbacks = buildStreamCallbacks(runId);

	try {
		const wrap = job.auto_approve_tools ? runWithAutoApprove : passthrough;
		const { finalText } = await wrap(() =>
			runEphemeralTurn({
				userMessage: step.prompt,
				workingDir: job.working_dir,
				contextSize: getActiveContextSize(),
				deepResearch: step.deep_research,
				visionSupported,
				signal: abort.signal,
				...callbacks
			})
		);
		finalizeRun(runId, { finalText, status: 'succeeded' });
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') {
			finalizeRun(runId, { status: 'cancelled', error: 'Cancelled by user' });
		} else {
			finalizeRun(runId, {
				status: 'failed',
				error: e instanceof Error ? e.message : String(e)
			});
		}
	} finally {
		if (activeAbort === abort) activeAbort = null;
	}
}

function passthrough<T>(fn: () => Promise<T>): Promise<T> {
	return fn();
}

export function cancel(runId: number): void {
	if (!current || current.id !== runId) return;
	if (current.status !== 'running') return;
	activeAbort?.abort();
}
