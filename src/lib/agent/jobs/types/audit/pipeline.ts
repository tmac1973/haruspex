/**
 * Audit run orchestration (job-plugins Phase 03) — moved out of
 * runner.svelte.ts. Execute N independent sample steps (each capturing
 * structured findings), then a synthesis step that clusters, source-verifies,
 * and reports. The pure sequencing lives in ./auditPipeline (orchestrateAudit);
 * this module binds it to the run's JobRunContext.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ResolvedToolCall } from '$lib/agent/parser';
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
import type { JobWithSteps } from '$lib/stores/jobs.svelte';
import { parseAuditConfig, type AuditConfig } from './config';
import { errMessage, normalizeAbort } from '$lib/utils/error';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted,
	type JobRunStepStatus
} from '$lib/stores/jobRuns.svelte';
import type { JobRunContext, PlannedStep } from '../types';
import type { RunStatus } from '../../runner.svelte';

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

/** Resolve the configured sample budget to a sane, bounded turn count. */
function auditSampleIterations(cfg: AuditConfig): number {
	const raw = cfg.max_iterations ?? DEFAULT_AUDIT_SAMPLE_ITERATIONS;
	return Math.max(1, Math.min(Math.floor(raw), MAX_AUDIT_SAMPLE_ITERATIONS));
}

/**
 * Audit jobs expand into N sample steps (the same prompt, run independently)
 * plus a trailing synthesis step.
 */
export function planAuditSteps(job: JobWithSteps): PlannedStep[] {
	const cfg = parseAuditConfig(job.type_config);
	const n = Math.max(1, Math.min(cfg.num_runs ?? 3, MAX_AUDIT_RUNS));
	const prompt = job.steps[0]?.prompt ?? '';
	const samples: PlannedStep[] = Array.from({ length: n }, () => ({
		authored: prompt,
		deepResearch: false
	}));
	// Synthesis (cluster → verify → report) is deterministic; this text is
	// only the step's display label, not a model prompt.
	return [...samples, { authored: DEFAULT_AUDIT_SYNTHESIS_PROMPT, deepResearch: false }];
}

/**
 * Step failure/cancellation is marked once, centrally, on whichever step was
 * live (tracked via liveStepIndex) when the error propagated.
 */
export async function runAuditPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId, abort } = ctx;
	const cfg = parseAuditConfig(job.type_config);
	void markRunStarted(runId, Date.now());
	const planned = planAuditSteps(job);
	const synthesisIndex = planned.length - 1;
	const numRuns = synthesisIndex; // every step but the last is a sample
	const auditPrompt = job.steps[0]?.prompt ?? '';

	try {
		const result = await orchestrateAudit({
			numRuns,
			jobName: job.name,
			signal: abort.signal,
			runSample: (i) => runAuditSampleStep(ctx, cfg, i, auditPrompt),
			beginSynthesis: () => {
				const startedAt = Date.now();
				ctx.setCurrentStepIndex(synthesisIndex);
				ctx.patchStep(synthesisIndex, {
					status: 'running',
					promptRendered: planned[synthesisIndex].authored,
					startedAt
				});
				void markRunStepStarted(runId, synthesisIndex, startedAt, planned[synthesisIndex].authored);
			},
			verifyCluster: (cluster, idx, total) =>
				verifyClusterTurn(ctx, cfg, synthesisIndex, cluster, idx, total)
		});

		// Write the report to the configured file (best-effort; failure is noted
		// in the step output but doesn't fail the run — the report is also saved
		// to the step itself).
		let note = '';
		if (cfg.output_file && job.working_dir) {
			try {
				await invoke('fs_write_text', {
					workdir: job.working_dir,
					relPath: cfg.output_file,
					content: result.report,
					overwrite: true
				});
				note = `\n\n_Report written to ${cfg.output_file}._`;
			} catch (e) {
				note = `\n\n_Could not write ${cfg.output_file}: ${errMessage(e)}_`;
			}
		}

		const finishedAt = Date.now();
		const output = result.report + note;
		ctx.patchStep(synthesisIndex, { status: 'succeeded', output, finishedAt });
		void markRunStepFinished(runId, synthesisIndex, 'succeeded', output, null, finishedAt);
		ctx.finalizeRun('succeeded', null);
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		const status: RunStatus = aborted ? 'cancelled' : 'failed';
		const stepStatus: JobRunStepStatus = aborted ? 'cancelled' : 'failed';
		const liveStep = ctx.liveStepIndex();
		const finishedAt = Date.now();
		ctx.patchStep(liveStep, { status: stepStatus, error: msg, finishedAt });
		void markRunStepFinished(runId, liveStep, stepStatus, null, msg, finishedAt);
		ctx.finalizeRun(status, msg);
	} finally {
		ctx.onSettled();
	}
}

/** Run one audit sample, returning the findings it submitted. Throws on failure. */
async function runAuditSampleStep(
	ctx: JobRunContext,
	cfg: AuditConfig,
	stepIndex: number,
	auditPrompt: string
): Promise<AuditFinding[]> {
	const { runId } = ctx;
	const startedAt = Date.now();
	const rendered = buildSamplePrompt(auditPrompt, cfg.sample_instructions);
	ctx.setCurrentStepIndex(stepIndex);
	ctx.patchStep(stepIndex, { status: 'running', promptRendered: rendered, startedAt });
	void markRunStepStarted(runId, stepIndex, startedAt, rendered);

	// Capture the submit_findings arguments off the tool-call stream.
	let captured: AuditFinding[] = [];
	const base = ctx.buildStreamCallbacks(stepIndex);
	const callbacks = {
		...base,
		onToolStart: (call: ResolvedToolCall) => {
			if (call.name === SUBMIT_FINDINGS_TOOL && Array.isArray(call.arguments?.findings)) {
				captured = call.arguments.findings as AuditFinding[];
			}
			base.onToolStart?.(call);
		}
	};

	const { finalText } = await ctx.runJobTurn({
		userMessage: rendered,
		contextSize: ctx.contextSize(),
		visionSupported: ctx.visionSupported(),
		toolAllowlist: SAMPLE_ALLOW,
		// Guarantee the run records structured findings: if the model burns its
		// whole budget exploring and never submits, force the submit_findings
		// call rather than discarding a prose answer.
		forceFinalTool: SUBMIT_FINDINGS_TOOL,
		maxIterations: auditSampleIterations(cfg),
		...callbacks
	});

	const finishedAt = Date.now();
	const output =
		`**${captured.length} finding(s)**\n\n` +
		`\`\`\`json\n${JSON.stringify(captured, null, 2)}\n\`\`\`` +
		(finalText.trim() ? `\n\n${finalText.trim()}` : '');
	ctx.patchStep(stepIndex, { status: 'succeeded', output, finishedAt });
	void markRunStepFinished(runId, stepIndex, 'succeeded', output, null, finishedAt);
	return captured;
}

/** Verify one cluster against source via a read-only submit_verdict turn. */
async function verifyClusterTurn(
	ctx: JobRunContext,
	cfg: AuditConfig,
	synthesisIndex: number,
	cluster: FindingCluster,
	idx: number,
	total: number
): Promise<{ verdict: AuditVerdict; evidence: string | null; location: string | null }> {
	ctx.patchStep(synthesisIndex, {
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

	await ctx.runJobTurn({
		userMessage: buildVerifyPrompt(cluster, cfg.verify_instructions),
		contextSize: ctx.contextSize(),
		visionSupported: ctx.visionSupported(),
		toolAllowlist: VERIFY_ALLOW,
		forceFinalTool: SUBMIT_VERDICT_TOOL,
		maxIterations: AUDIT_VERIFY_MAX_ITERATIONS,
		onToolStart
	});
	return { verdict, evidence, location };
}
