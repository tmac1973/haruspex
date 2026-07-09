/**
 * Research pipeline (job-plugins Phase 02) — the original sequential job
 * runner, moved out of runner.svelte.ts: walk the authored steps in order,
 * prepending the previous step's output to each subsequent step's prompt.
 * On first failure the run halts; remaining steps stay `pending`.
 */

import type { JobWithSteps } from '$lib/stores/jobs.svelte';
import { normalizeAbort } from '$lib/utils/error';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted,
	type JobRunStepStatus
} from '$lib/stores/jobRuns.svelte';
import { logDebug } from '$lib/debug-log';
import type { JobRunContext, PlannedStep } from '../types';
import type { RunStatus } from '../../runner.svelte';

/** Research jobs map 1:1 to their authored steps. */
export function planResearchSteps(job: JobWithSteps): PlannedStep[] {
	return job.steps.map((s) => ({ authored: s.prompt, deepResearch: s.deep_research }));
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

function renderPrompt(stepIndex: number, authored: string, priorOutput: string): string {
	if (stepIndex === 0) return authored;
	if (!priorOutput) return authored;
	return `${priorOutput}\n\n${authored}`;
}

async function runOneStep(
	ctx: JobRunContext,
	stepIndex: number,
	rendered: string
): Promise<{ ok: true; output: string } | { ok: false; aborted: boolean; error: string }> {
	const { job, runId } = ctx;
	const step = job.steps[stepIndex];
	const startedAt = Date.now();

	const contextSize = ctx.contextSize();
	const sizeWarning = estimateSizeWarning(rendered, contextSize);
	if (sizeWarning) {
		logDebug('jobs', 'step prompt over budget', {
			runId,
			stepIndex,
			length: rendered.length,
			contextSize
		});
	}
	ctx.patchStep(stepIndex, {
		status: 'running',
		promptRendered: rendered,
		sizeWarning,
		startedAt
	});
	ctx.setCurrentStepIndex(stepIndex);
	void markRunStepStarted(runId, stepIndex, startedAt, rendered);

	try {
		const { finalText } = await ctx.runJobTurn({
			userMessage: rendered,
			contextSize,
			deepResearch: step.deep_research,
			visionSupported: ctx.visionSupported(),
			...ctx.buildStreamCallbacks(stepIndex)
		});
		const finishedAt = Date.now();
		ctx.patchStep(stepIndex, {
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
		ctx.patchStep(stepIndex, {
			status: stepStatus,
			error: msg,
			finishedAt
		});
		void markRunStepFinished(runId, stepIndex, stepStatus, null, msg, finishedAt);
		return { ok: false, aborted, error: msg };
	}
}

export async function runResearchPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId, abort } = ctx;
	void markRunStarted(runId, Date.now());
	let priorOutput = '';
	try {
		for (let i = 0; i < job.steps.length; i++) {
			if (!ctx.isLive()) return;
			// If the user cancelled between steps, finalize cleanly without
			// flickering the next step to 'running' before bailing.
			if (abort.signal.aborted) {
				ctx.finalizeRun('cancelled', 'Cancelled by user');
				return;
			}
			const authored = job.steps[i].prompt;
			const rendered = renderPrompt(i, authored, priorOutput);
			const result = await runOneStep(ctx, i, rendered);
			if (!result.ok) {
				const status: RunStatus = result.aborted ? 'cancelled' : 'failed';
				ctx.finalizeRun(status, result.error);
				return;
			}
			priorOutput = result.output;
		}
		ctx.finalizeRun('succeeded', null);
	} finally {
		ctx.onSettled();
	}
}
