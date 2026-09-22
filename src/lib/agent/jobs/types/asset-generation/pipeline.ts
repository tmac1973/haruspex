/**
 * The asset-generation run.
 *
 * Five stages, declared here so their indices never move: Spec, Style anchor,
 * Generate, Report, Handoff. This phase ships the skeleton — the run view, the
 * queue, cancellation, the config round-trip and the report all work before any
 * generation logic exists to confuse them — and later phases fill each stage
 * in without adding one.
 */

import { invoke } from '@tauri-apps/api/core';
import { normalizeAbort } from '$lib/utils/error';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted,
	type JobRunStepStatus
} from '$lib/stores/jobRuns.svelte';
import type { JobRunContext } from '../types';
import type { RunStatus } from '../../runner.svelte';
import { parseAssetGenerationConfig, resolveSpecPath, DEFAULT_TARGET_SIZE } from './config';
import { parseAssetSpec } from '$lib/assets/spec/parse';
import { renderAssetSpec } from '$lib/assets/spec/write';
import { validateAssetSpec } from '$lib/assets/spec/validate';
import type { AssetSpec } from '$lib/assets/spec/types';
import { defaultProfile } from '$lib/assets/normalize';
import { resolveImageBackend } from '$lib/image';
import { SUBMIT_ASSET_SPEC_TOOL } from '$lib/agent/tools/coding';
import type { ResolvedToolCall } from '$lib/agent/parser';
import { deriveSpec, type DerivePayload } from './derive';
import { specDerivationPrompt, specRetryPrompt } from './prompts';

/** Read-only: the derivation grounds itself in the project, it does not edit it. */
const DERIVE_TOOLS = ['fs_read_text', 'fs_list_dir', 'code_grep', 'code_glob'];

/** One retry with the problems quoted, then the stage fails honestly. */
const MAX_DERIVE_ATTEMPTS = 2;

export const SPEC = 0;
export const ANCHOR = 1;
export const GENERATE = 2;
export const REPORT = 3;
export const HANDOFF = 4;

/** One asset line for the stage output. */
function breakdown(spec: AssetSpec): string {
	const byKind = spec.entries.reduce<Record<string, number>>((acc, e) => {
		acc[e.kind] = (acc[e.kind] ?? 0) + 1;
		return acc;
	}, {});
	return (
		Object.entries(byKind)
			.map(([k, n]) => `${n} ${k}`)
			.join(', ') || 'nothing'
	);
}

/** Report lands beside the spec — fixed here, not by whoever writes it later. */
export function reportPathFor(specPath: string): string {
	const slash = specPath.lastIndexOf('/');
	return slash < 0 ? 'REPORT-assets.md' : `${specPath.slice(0, slash)}/REPORT-assets.md`;
}

async function readWorkdirFile(ctx: JobRunContext, relPath: string): Promise<string | null> {
	if (!ctx.job.working_dir) return null;
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

export async function runAssetGenerationPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId, abort } = ctx;
	const cfg = parseAssetGenerationConfig(job.type_config);
	const specPath = resolveSpecPath(cfg);
	const reportPath = reportPathFor(specPath);
	const targetSize = cfg.target_size ?? DEFAULT_TARGET_SIZE;

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
			throw new Error('No working directory — the job needs somewhere to write assets.');
		}
		// The availability gate refuses to enqueue without a backend, so this
		// covers only what it cannot: a run queued while one was configured
		// that reaches the front of the queue — possibly twelve hours later,
		// behind a coding job — after the setting changed.
		if (resolveImageBackend().kind === 'none') {
			throw new Error('No image backend configured — Settings → Image.');
		}

		startStep(SPEC);
		abortIfCancelled();
		const json = await readWorkdirFile(ctx, specPath);
		let spec: AssetSpec;

		if (json !== null) {
			// A spec the user wrote is theirs. Parsed and validated, never
			// silently rewritten — a run that "fixes" someone's file by
			// replacing it has destroyed the thing it was asked to work from.
			const parsed = parseAssetSpec(json);
			if ('errors' in parsed) {
				throw new Error(`The spec at ${specPath} could not be read:\n${parsed.errors.join('\n')}`);
			}
			const problems = validateAssetSpec(parsed.spec);
			if (problems.length > 0) {
				throw new Error(`The spec at ${specPath} has problems:\n${problems.join('\n')}`);
			}
			spec = parsed.spec;
			finishStep(SPEC, `${specPath} — ${spec.entries.length} asset(s): ${breakdown(spec)}`);
		} else {
			if (!cfg.description) {
				throw new Error(
					`No spec at ${specPath} and nothing to write one from — set a spec path that ` +
						`exists, or describe what to make.`
				);
			}
			const profile = { ...(await defaultProfile()), target_size: targetSize };
			let derived: AssetSpec | null = null;
			let problems: string[] = [];
			for (let attempt = 0; attempt < MAX_DERIVE_ATTEMPTS; attempt++) {
				abortIfCancelled();
				let captured: DerivePayload | null = null;
				const base = ctx.buildStreamCallbacks(SPEC);
				await ctx.runJobTurn({
					turnKind: 'spec.derive',
					userMessage:
						attempt === 0
							? `List the images this project needs, then call ${SUBMIT_ASSET_SPEC_TOOL}.`
							: specRetryPrompt(problems),
					contextSize: ctx.contextSize(),
					visionSupported: ctx.visionSupported(),
					maxIterations: 40,
					systemPrompt: specDerivationPrompt(cfg.description, specPath),
					toolAllowlist: [...DERIVE_TOOLS, SUBMIT_ASSET_SPEC_TOOL],
					forceFinalTool: SUBMIT_ASSET_SPEC_TOOL,
					...base,
					onToolStart: (call: ResolvedToolCall) => {
						if (call.name === SUBMIT_ASSET_SPEC_TOOL && call.arguments) {
							captured = call.arguments as DerivePayload;
						}
						base.onToolStart?.(call);
					}
				});
				if (captured === null) {
					problems = ['No spec was submitted — call the tool.'];
					continue;
				}
				const candidate = deriveSpec(captured, profile);
				problems = validateAssetSpec(candidate);
				if (problems.length === 0) {
					derived = candidate;
					break;
				}
			}
			if (derived === null) {
				throw new Error(
					`Could not write a usable spec after ${MAX_DERIVE_ATTEMPTS} attempts:\n` +
						problems.join('\n')
				);
			}
			spec = derived;
			await writeWorkdirFile(ctx, specPath, renderAssetSpec(spec));
			finishStep(
				SPEC,
				`Wrote ${specPath} — ${spec.entries.length} asset(s): ${breakdown(spec)}\n\n` +
					`Style: ${spec.style.prompt}`
			);
		}
		const entryCount = spec.entries.length;

		startStep(ANCHOR);
		abortIfCancelled();
		finishStep(ANCHOR, 'Not implemented yet.');

		startStep(GENERATE);
		abortIfCancelled();
		finishStep(GENERATE, 'Not implemented yet.');

		startStep(REPORT);
		abortIfCancelled();
		await writeWorkdirFile(
			ctx,
			reportPath,
			[
				'# Asset report',
				'',
				`Spec: \`${specPath}\` — ${entryCount} asset(s).`,
				'',
				'Generation is not implemented yet; this run only read the spec.',
				''
			].join('\n')
		);
		finishStep(REPORT, `Done — ${reportPath}`);

		startStep(HANDOFF);
		abortIfCancelled();
		finishStep(
			HANDOFF,
			ctx.trigger === 'chained'
				? 'Nothing chained yet — the coding handoff is not implemented.'
				: 'Nothing chained — this run was started manually.'
		);

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
