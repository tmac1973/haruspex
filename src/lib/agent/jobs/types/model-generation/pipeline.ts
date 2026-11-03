/**
 * The 3D models run.
 *
 * Stages, declared here so their indices never move: Spec, Create, Animate,
 * Report. The handoff to a coding run goes last when it lands, so nothing
 * before it renumbers. Spec and Create run; Animate and Report finish as
 * skipped until their phases fill them in.
 */

import { invoke } from '@tauri-apps/api/core';
import { PROJECT_READ_TOOLS } from '#lib/agent/jobs/readTools.ts';
import { normalizeAbort } from '#lib/utils/error.ts';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted,
	type JobRunStepStatus
} from '#lib/stores/jobRuns.svelte.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { RunStatus } from '#lib/agent/jobs/runner.svelte.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import {
	parseModelGenerationConfig,
	resolveModelsSpecPath,
	type ModelGenerationConfig
} from '#lib/agent/jobs/types/model-generation/config.ts';
import {
	SUBMIT_MODEL_SPEC_TOOL,
	specFromSubmission
} from '#lib/agent/jobs/types/model-generation/tools.ts';
import {
	modelSpecPrompt,
	modelSpecRetryPrompt
} from '#lib/agent/jobs/types/model-generation/prompts.ts';
import { parseModelSpec } from '#lib/models3d/spec/parse.ts';
import { validateModelSpec } from '#lib/models3d/spec/validate.ts';
import { renderModelSpec } from '#lib/models3d/spec/write.ts';
import { createStage, entrySummary } from '#lib/agent/jobs/types/model-generation/create.ts';
import { initialEntryStates } from '#lib/agent/jobs/types/model-generation/state.ts';
import type { ModelSpec } from '#lib/models3d/spec/types.ts';

/** One retry with the problems quoted, then the stage fails honestly. */
const MAX_DERIVE_ATTEMPTS = 2;
/** Model steps for one spec-writing turn: room to read a plan, then submit. */
const DERIVE_TURNS = 40;

export const SPEC = 0;
export const CREATE = 1;
export const ANIMATE = 2;
export const REPORT = 3;

/** "4 models, 2 animated (Idle, Walk, Attack)". */
export function specSummary(spec: ModelSpec): string {
	const animated = spec.entries.filter((e) => e.clips.length > 0);
	const clips = [...new Set(animated.flatMap((e) => e.clips.map((c) => c.name)))];
	return (
		`${spec.entries.length} model(s), ${animated.length} animated` +
		(clips.length > 0 ? ` (${clips.join(', ')})` : '')
	);
}

async function readWorkdirFile(ctx: JobRunContext, relPath: string): Promise<string | null> {
	try {
		return await invoke<string>('fs_read_text_full', {
			workdir: ctx.job.working_dir,
			relPath
		});
	} catch {
		return null;
	}
}

async function writeWorkdirFile(
	ctx: JobRunContext,
	relPath: string,
	content: string
): Promise<void> {
	await invoke('fs_write_text', {
		workdir: ctx.job.working_dir,
		relPath,
		content,
		overwrite: true
	});
}

/**
 * Write a spec from the job's description, on the job's own model. One turn,
 * and one more with the problems quoted when the first submission is not a
 * usable spec. Throws when neither is.
 */
async function deriveModelSpec(
	ctx: JobRunContext,
	description: string,
	specPath: string,
	stepIndex: number,
	abortIfCancelled: () => void
): Promise<ModelSpec> {
	let problems: string[] = [];
	for (let attempt = 0; attempt < MAX_DERIVE_ATTEMPTS; attempt++) {
		abortIfCancelled();
		let captured: Record<string, unknown> | null = null;
		const base = ctx.buildStreamCallbacks(stepIndex);
		await ctx.runJobTurn({
			turnKind: 'models.derive',
			userMessage:
				attempt === 0
					? `List the 3D models this project needs, then call ${SUBMIT_MODEL_SPEC_TOOL}.`
					: modelSpecRetryPrompt(problems),
			contextSize: ctx.contextSize(),
			visionSupported: ctx.visionSupported(),
			maxIterations: DERIVE_TURNS,
			systemPrompt: modelSpecPrompt(description, specPath),
			toolAllowlist: [...PROJECT_READ_TOOLS, SUBMIT_MODEL_SPEC_TOOL],
			forceFinalTool: SUBMIT_MODEL_SPEC_TOOL,
			...base,
			onToolStart: (call: ResolvedToolCall) => {
				if (call.name === SUBMIT_MODEL_SPEC_TOOL && call.arguments) {
					captured = call.arguments;
				}
				base.onToolStart?.(call);
			}
		});
		if (captured === null) {
			problems = ['No spec was submitted — call the tool.'];
			continue;
		}
		const candidate = specFromSubmission(captured);
		problems = validateModelSpec(candidate);
		if (problems.length === 0) return candidate;
	}
	throw new Error(
		`Could not write a usable models spec after ${MAX_DERIVE_ATTEMPTS} attempts:\n` +
			problems.join('\n')
	);
}

/**
 * Read the spec at `specPath`, or write one from the description when there
 * is none. Returns the spec and the stage's output line.
 */
async function specStage(
	ctx: JobRunContext,
	cfg: ModelGenerationConfig,
	specPath: string,
	abortIfCancelled: () => void
): Promise<{ spec: ModelSpec; output: string }> {
	const json = await readWorkdirFile(ctx, specPath);
	if (json !== null) {
		// A spec the user wrote is theirs: read and checked, never rewritten.
		// A run that "fixes" someone's file by replacing it has destroyed the
		// thing it was asked to work from.
		const parsed = parseModelSpec(json);
		if ('errors' in parsed) {
			throw new Error(`The spec at ${specPath} could not be read:\n${parsed.errors.join('\n')}`);
		}
		const problems = validateModelSpec(parsed.spec);
		if (problems.length > 0) {
			throw new Error(`The spec at ${specPath} has problems:\n${problems.join('\n')}`);
		}
		return { spec: parsed.spec, output: `${specPath} — ${specSummary(parsed.spec)}` };
	}
	if (!cfg.description) throw new Error('No models.json and no description.');
	const spec = await deriveModelSpec(ctx, cfg.description, specPath, SPEC, abortIfCancelled);
	await writeWorkdirFile(ctx, specPath, renderModelSpec(spec));
	return {
		spec,
		output:
			`Wrote ${specPath} — ${specSummary(spec)}` + (spec.style ? `\n\nStyle: ${spec.style}` : '')
	};
}

export async function runModelGenerationPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId, abort } = ctx;
	const cfg = parseModelGenerationConfig(job.type_config);
	const specPath = resolveModelsSpecPath(cfg);

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

	void markRunStarted(runId, Date.now());

	try {
		if (!job.working_dir) {
			throw new Error('No working directory — the job needs somewhere to write models.');
		}

		startStep(SPEC);
		abortIfCancelled();
		const { spec, output } = await specStage(ctx, cfg, specPath, abortIfCancelled);
		finishStep(SPEC, output);

		startStep(CREATE);
		const states = initialEntryStates(spec);
		await createStage(ctx, cfg, spec, states, CREATE);
		finishStep(CREATE, entrySummary(spec, states));

		// Started and finished rather than left pending, so the run view shows
		// what did not run, as guided planning does for a stage switched off.
		for (const idx of [ANIMATE, REPORT]) {
			startStep(idx);
			finishStep(idx, 'Skipped — not built yet.');
		}

		ctx.finalizeRun('succeeded', null);
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		const stepStatus: JobRunStepStatus = aborted ? 'cancelled' : 'failed';
		const finishedAt = Date.now();
		const idx = ctx.liveStepIndex();
		ctx.patchStep(idx, { status: stepStatus, error: msg, finishedAt });
		void markRunStepFinished(runId, idx, stepStatus, null, msg, finishedAt);
		const status: RunStatus = aborted ? 'cancelled' : 'failed';
		ctx.finalizeRun(status, aborted ? null : msg);
	} finally {
		ctx.onSettled();
	}
}
