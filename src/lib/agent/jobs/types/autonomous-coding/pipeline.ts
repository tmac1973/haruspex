/**
 * Autonomous-coding pipeline. Phase 05 implements Stage 0 (the preflight
 * interview — the last human checkpoint before an unattended run); the
 * decompose stage and the ralph loop land in Phase 06, so for now a run
 * fails honestly after a successful preflight instead of pretending to code.
 *
 * Stage index constants must match CODING_STAGES in ./definition.ts.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ResolvedToolCall } from '$lib/agent/parser';
import { SUBMIT_PREFLIGHT_TOOL, type PreflightResultArg } from '$lib/agent/tools/coding';
import { normalizeAbort } from '$lib/utils/error';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted,
	type JobRunStepStatus
} from '$lib/stores/jobRuns.svelte';
import type { JobRunContext } from '../types';
import { normalizePlanDir, parseAutonomousCodingConfig } from './config';
import { preflightPrompt } from './prompts';

export const PREFLIGHT = 0;
export const DECOMPOSE = 1;
export const LOOP = 2;
export const FINALIZE = 3;

/**
 * Preflight toolset: read-only grounding, the one write (the decisions file,
 * held to the plan dir via writeRoot), the question modal, and the forced
 * structured verdict. No shell — nothing executes until the loop (Phase 06).
 */
const PREFLIGHT_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'fs_read_pdf',
	'code_grep',
	'code_glob',
	'fs_write_text',
	'ask_user_question',
	SUBMIT_PREFLIGHT_TOOL
];

/** Turn budget: a plan-wide interview can take many question round-trips. */
const PREFLIGHT_MAX_ITERATIONS = 80;

/** Bounded retries for the decisions-file write guard (guided's pattern). */
const MAX_WRITE_ATTEMPTS = 3;

interface PreflightOutcome {
	ready: boolean;
	blockers: string[];
	decisionsResolved: number | null;
}

export async function runAutonomousCodingPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId, abort } = ctx;
	const cfg = parseAutonomousCodingConfig(job.type_config);
	void markRunStarted(runId, Date.now());

	const startStep = (idx: number) => {
		const startedAt = Date.now();
		ctx.patchStep(idx, { status: 'running', startedAt });
		ctx.setCurrentStepIndex(idx);
		void markRunStepStarted(runId, idx, startedAt, ctx.stepAuthored(idx));
	};
	const finishStep = (idx: number, output: string) => {
		const finishedAt = Date.now();
		ctx.patchStep(idx, { status: 'succeeded', output, finishedAt });
		void markRunStepFinished(runId, idx, 'succeeded', output, null, finishedAt);
	};
	const abortIfCancelled = () => {
		if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
	};

	try {
		if (!cfg.plan_dir) {
			throw new Error('No plan directory configured — edit the job and set one.');
		}
		const planDir = normalizePlanDir(cfg.plan_dir);
		const decisionsPath = `${planDir}DECISIONS-coding.md`;

		// Stage 0 — Preflight: the last human checkpoint. Resolve every open
		// decision via the question modal, record them, and get a structured
		// ready/blocked verdict before anything runs unattended.
		startStep(PREFLIGHT);
		const outcome = await runPreflightTurn(ctx, planDir, decisionsPath);
		abortIfCancelled();
		if (!outcome.ready) {
			const why = outcome.blockers.length
				? outcome.blockers.map((b) => `- ${b}`).join('\n')
				: '- (no blockers given)';
			throw new Error(`Preflight found blockers — fix the plan and re-run:\n${why}`);
		}
		await ensureDecisionsWritten(ctx, planDir, decisionsPath, abortIfCancelled);
		finishStep(
			PREFLIGHT,
			`Ready to code — ${outcome.decisionsResolved ?? 0} decision(s) resolved → ${decisionsPath}`
		);

		// Phase 06 continues here: decompose → loop → finalize. Fail on the
		// Decompose stage (not the completed preflight) so the run view shows
		// exactly where the not-yet-implemented part starts.
		startStep(DECOMPOSE);
		throw new Error(
			'Preflight complete, but the coding loop is not implemented yet (job-plugins Phase 06).'
		);
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		const stepStatus: JobRunStepStatus = aborted ? 'cancelled' : 'failed';
		const finishedAt = Date.now();
		const idx = ctx.liveStepIndex();
		ctx.patchStep(idx, { status: stepStatus, error: msg, finishedAt });
		void markRunStepFinished(runId, idx, stepStatus, null, msg, finishedAt);
		ctx.finalizeRun(aborted ? 'cancelled' : 'failed', msg);
	} finally {
		ctx.onSettled();
	}
}

/** One interactive preflight turn; the verdict is captured off the tool stream. */
async function runPreflightTurn(
	ctx: JobRunContext,
	planDir: string,
	decisionsPath: string
): Promise<PreflightOutcome> {
	let captured: PreflightResultArg | null = null;
	const base = ctx.buildStreamCallbacks(PREFLIGHT);
	await ctx.runJobTurn({
		userMessage:
			`Run the preflight for the plan in ${planDir}. Interview me about anything ` +
			`unresolved — after this I will not be available.`,
		contextSize: ctx.contextSize(),
		visionSupported: ctx.visionSupported(),
		maxIterations: PREFLIGHT_MAX_ITERATIONS,
		interactive: true,
		writeRoot: planDir,
		systemPrompt: preflightPrompt(planDir, decisionsPath),
		toolAllowlist: PREFLIGHT_TOOLS,
		forceFinalTool: SUBMIT_PREFLIGHT_TOOL,
		...base,
		onToolStart: (call: ResolvedToolCall) => {
			if (call.name === SUBMIT_PREFLIGHT_TOOL && typeof call.arguments?.ready === 'boolean') {
				captured = call.arguments as unknown as PreflightResultArg;
			}
			base.onToolStart?.(call);
		}
	});
	if (!captured) {
		// forceFinalTool makes this near-impossible, but never proceed to an
		// unattended run on a missing verdict.
		return {
			ready: false,
			blockers: ['The model never reported a preflight verdict.'],
			decisionsResolved: null
		};
	}
	const result = captured as PreflightResultArg;
	return {
		ready: result.ready,
		blockers: Array.isArray(result.blockers)
			? result.blockers.filter((b): b is string => typeof b === 'string')
			: [],
		decisionsResolved:
			typeof result.decisions_resolved === 'number' ? result.decisions_resolved : null
	};
}

/**
 * The decisions file is the loop's ground truth for every resolved question —
 * verify it landed on disk (the model may narrate a write without calling the
 * tool), retrying with a pointed prompt before giving up honestly.
 */
async function ensureDecisionsWritten(
	ctx: JobRunContext,
	planDir: string,
	decisionsPath: string,
	abortIfCancelled: () => void
): Promise<void> {
	const exists = async (): Promise<boolean> => {
		if (!ctx.job.working_dir) return true; // no sandbox root → can't verify
		try {
			return await invoke<boolean>('fs_path_exists', {
				workdir: ctx.job.working_dir,
				relPath: decisionsPath
			});
		} catch {
			return false;
		}
	};
	for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
		abortIfCancelled();
		if (await exists()) return;
		await ctx.runJobTurn({
			userMessage:
				`I don't see ${decisionsPath} on disk yet — you may have described writing it ` +
				`without actually calling fs_write_text. Do NOT ask any more questions; write ` +
				`the decisions file to ${decisionsPath} now with fs_write_text, then stop.`,
			contextSize: ctx.contextSize(),
			visionSupported: ctx.visionSupported(),
			maxIterations: 10,
			writeRoot: planDir,
			systemPrompt: preflightPrompt(planDir, decisionsPath),
			toolAllowlist: PREFLIGHT_TOOLS,
			expectsFileOutput: true,
			...ctx.buildStreamCallbacks(PREFLIGHT)
		});
	}
	abortIfCancelled();
	if (!(await exists())) {
		throw new Error(
			`The decisions file was never written to ${decisionsPath} after ` +
				`${MAX_WRITE_ATTEMPTS} attempts. The selected model may be too small to follow ` +
				`the write step reliably — try a larger model.`
		);
	}
}
