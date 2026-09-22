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
import { parseAssetGenerationConfig, resolveSpecPath } from './config';
import { parseAssetSpec } from '$lib/assets/spec/parse';
import { validateAssetSpec } from '$lib/assets/spec/validate';
import { resolveImageBackend } from '$lib/image';

export const SPEC = 0;
export const ANCHOR = 1;
export const GENERATE = 2;
export const REPORT = 3;
export const HANDOFF = 4;

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
		let entryCount = 0;
		if (json === null) {
			finishStep(SPEC, `No spec at ${specPath} — nothing to generate yet.`);
		} else {
			const parsed = parseAssetSpec(json);
			if ('errors' in parsed) {
				throw new Error(`The spec at ${specPath} could not be read:\n${parsed.errors.join('\n')}`);
			}
			const problems = validateAssetSpec(parsed.spec);
			if (problems.length > 0) {
				throw new Error(`The spec at ${specPath} has problems:\n${problems.join('\n')}`);
			}
			entryCount = parsed.spec.entries.length;
			const byKind = parsed.spec.entries.reduce<Record<string, number>>((acc, e) => {
				acc[e.kind] = (acc[e.kind] ?? 0) + 1;
				return acc;
			}, {});
			const breakdown = Object.entries(byKind)
				.map(([k, n]) => `${n} ${k}`)
				.join(', ');
			finishStep(SPEC, `${specPath} — ${entryCount} asset(s): ${breakdown}`);
		}

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
