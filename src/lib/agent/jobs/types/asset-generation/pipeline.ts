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
import { createJob } from '$lib/stores/jobs.svelte';
import { normalizeAbort } from '$lib/utils/error';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted,
	type JobRunStepStatus
} from '$lib/stores/jobRuns.svelte';
import type { JobRunContext } from '../types';
import type { RunStatus } from '../../runner.svelte';
import type { AssetGenerationConfig } from './config';
import {
	parseAssetGenerationConfig,
	resolveSpecPath,
	DEFAULT_ANCHOR_ATTEMPTS,
	DEFAULT_CONCURRENCY,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_TARGET_SIZE,
	DEFAULT_VISION_JUDGE,
	MAX_GENERATION_EDGE
} from './config';
import { parseAssetSpec } from '$lib/assets/spec/parse';
import { renderAssetSpec } from '$lib/assets/spec/write';
import { validateAssetSpec } from '$lib/assets/spec/validate';
import type { AssetSpec } from '$lib/assets/spec/types';
import { contactSheet, defaultProfile } from '$lib/assets/normalize';
import { resolveImageBackend } from '$lib/image';
import { SUBMIT_ASSET_SPEC_TOOL } from '$lib/agent/tools/coding';
import type { ResolvedToolCall } from '$lib/agent/parser';
import { deriveSpec, type DerivePayload } from './derive';
import { judgePrompt, specDerivationPrompt, specRetryPrompt } from './prompts';
import { establishAnchor } from './anchor';
import { parseJudgement, SUBMIT_ASSET_JUDGEMENT_TOOL, type AssetJudgement } from './tools';
import type { AssetEntry } from '$lib/assets/spec/types';
import { generateEntries } from './generate';
import { renderAssetReport } from './report';
import type { AnchorOutcome, EntryOutcome } from './types';

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

function samePalette(a: number[], b: number[]): boolean {
	return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** Report lands beside the spec — fixed here, not by whoever writes it later. */
export function reportPathFor(specPath: string): string {
	const slash = specPath.lastIndexOf('/');
	return slash < 0 ? 'REPORT-assets.md' : `${specPath.slice(0, slash)}/REPORT-assets.md`;
}

/** Counts by status, so the stage line and the report cannot disagree. */
function countByStatus(entries: EntryOutcome[]) {
	const n = (s: EntryOutcome['status']) => entries.filter((e) => e.status === s).length;
	return { done: n('done'), skipped: n('skipped'), failed: n('failed') };
}

/**
 * Which coherence layers the run did without, and how many entries each cost.
 *
 * Aggregated rather than listed per entry: forty identical lines saying "no
 * reference conditioning" is how a reader stops reading the report.
 */
function degradedSummary(entries: EntryOutcome[]): string {
	const counts = new Map<string, number>();
	for (const e of entries) {
		for (const d of e.degraded) counts.set(d, (counts.get(d) ?? 0) + 1);
	}
	if (counts.size === 0) return '';
	return `Degraded: ${[...counts].map(([d, n]) => `${d} (${n})`).join('; ')}.`;
}

async function workdirPathExists(ctx: JobRunContext, relPath: string): Promise<boolean> {
	if (!ctx.job.working_dir) return false;
	try {
		return await invoke<boolean>('fs_path_exists', {
			workdir: ctx.job.working_dir,
			relPath
		});
	} catch {
		return false;
	}
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

async function readWorkdirBytes(ctx: JobRunContext, relPath: string): Promise<Uint8Array | null> {
	if (!ctx.job.working_dir) return null;
	try {
		const bytes = await invoke<number[]>('fs_read_bytes', {
			workdir: ctx.job.working_dir,
			relPath
		});
		return new Uint8Array(bytes);
	} catch {
		return null;
	}
}

async function writeWorkdirBytes(
	ctx: JobRunContext,
	relPath: string,
	bytes: Uint8Array
): Promise<void> {
	await invoke('fs_write_bytes', {
		workdir: ctx.job.working_dir,
		relPath,
		bytes: Array.from(bytes),
		overwrite: true
	});
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

/** Bytes a vision model can be handed, without a file on disk in between. */
function dataUrl(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return `data:image/png;base64,${btoa(binary)}`;
}

/**
 * One judging turn: the anchor and the asset, side by side.
 *
 * Both images go in as one prior user message, because the question is a
 * comparison — handed the asset alone the model has nothing to compare it to
 * and grades craft instead, which is exactly what the prompt forbids.
 *
 * Returns null when the turn produced no judgement, which the gate treats as
 * no opinion rather than as approval.
 */
async function judgeAsset(
	ctx: JobRunContext,
	spec: AssetSpec,
	entry: AssetEntry,
	image: Uint8Array,
	anchor: Uint8Array
): Promise<AssetJudgement | null> {
	let verdict: AssetJudgement | null = null;
	await ctx.runJobTurn({
		userMessage: judgePrompt(entry.prompt, spec.style.prompt),
		history: [
			{
				role: 'user',
				content: [
					{ type: 'image_url', image_url: { url: dataUrl(anchor) } },
					{ type: 'image_url', image_url: { url: dataUrl(image) } }
				]
			}
		],
		contextSize: ctx.contextSize(),
		visionSupported: true,
		toolAllowlist: [SUBMIT_ASSET_JUDGEMENT_TOOL],
		forceFinalTool: SUBMIT_ASSET_JUDGEMENT_TOOL,
		maxIterations: 1,
		turnKind: 'asset.judge',
		onToolStart: (call: ResolvedToolCall) => {
			if (call.name === SUBMIT_ASSET_JUDGEMENT_TOOL) verdict = parseJudgement(call.arguments);
		}
	});
	return verdict;
}

/**
 * Tile everything the run actually produced into one sheet beside the spec.
 *
 * "A contact sheet of the set reads as one game" is the criterion the feature
 * is aimed at, and it is not checkable by opening forty PNGs one at a time.
 * Failing to build it is never fatal — it is a review aid, not an asset.
 */
async function writeContactSheet(
	ctx: JobRunContext,
	spec: AssetSpec,
	entries: EntryOutcome[],
	specPath: string
): Promise<string | null> {
	const produced = entries
		.filter((e) => e.status === 'done' || e.status === 'skipped')
		.map((e) => spec.entries.find((x) => x.id === e.id)?.out)
		.filter((p): p is string => typeof p === 'string');
	if (produced.length === 0) return null;
	try {
		const images: Uint8Array[] = [];
		for (const rel of produced) {
			const bytes = await readWorkdirBytes(ctx, rel);
			if (bytes && bytes.length > 0) images.push(bytes);
		}
		if (images.length === 0) return null;
		// Four times the target size: a 32 px asset is illegible at 32 px.
		const cell = (spec.normalize.target_size || DEFAULT_TARGET_SIZE) * 4;
		const sheet = await contactSheet(images, cell);
		const dir = specPath.lastIndexOf('/');
		const rel = dir < 0 ? 'contact-sheet.png' : `${specPath.slice(0, dir)}/contact-sheet.png`;
		await writeWorkdirBytes(ctx, rel, sheet);
		return rel;
	} catch {
		return null;
	}
}

/**
 * Start the coding run this asset run was chained ahead of, or say why not.
 *
 * Never throws. A run that has already produced a set of assets must not be
 * recorded as failed over a handoff it could not complete — `createJob` and
 * `startChainedRun` both report failure by returning null, and each is
 * reported rather than propagated. Same shape as guided planning's handoff,
 * for the same reason: the morning's first question is "did it chain, and if
 * not why not", and the run timeline should answer it.
 */
async function handoffToCoding(
	ctx: JobRunContext,
	cfg: AssetGenerationConfig,
	specPath: string,
	entries: EntryOutcome[]
): Promise<string> {
	const { job, runId } = ctx;
	if (ctx.trigger !== 'chained') {
		return 'Nothing chained — this run was started manually.';
	}
	if (!cfg.coding_run) {
		return 'Nothing chained — this run carried no coding configuration.';
	}

	// The coding run's preflight can see which art is missing, so it plans
	// around a gap instead of writing code that loads a file nobody made.
	const missing = entries.filter((e) => e.status !== 'done' && e.status !== 'skipped');
	const note = missing.length
		? ` ${missing.length} asset(s) could not be produced and are NOT on disk: ` +
			`${missing.map((e) => e.id).join(', ')}.`
		: '';

	const codingJobId = await createJob({
		name: `${job.name} — coding`,
		description:
			`Started automatically by asset-generation run ${runId}. ` +
			`The asset spec is at ${specPath}.${note}`,
		working_dir: job.working_dir,
		auto_approve_tools: true,
		schedule_kind: 'manual',
		schedule_config: null,
		next_due_at: null,
		job_type: 'autonomous_coding',
		// Inherited so the code is built on what the plan was built on — a
		// chained run has no chance to be corrected before it executes.
		model_remote_base_url: job.model_remote_base_url,
		model_remote_api_key: job.model_remote_api_key,
		model_remote_api_key_id: job.model_remote_api_key_id,
		model_remote_model_id: job.model_remote_model_id,
		model_remote_context_size: job.model_remote_context_size,
		model_remote_vision_supported: job.model_remote_vision_supported,
		model_advanced: job.model_advanced,
		type_config: JSON.stringify({
			...cfg.coding_run,
			// Set here, not carried: this run is the thing that knows where the
			// spec ended up, and the preflight checks the plan's asset ids
			// against it.
			asset_spec_path: specPath
		})
	});
	if (codingJobId === null) return 'Could not create the coding job — nothing was started.';

	const codingRunId = await ctx.startChainedRun(codingJobId);
	if (codingRunId === null) {
		return (
			`Created coding job ${codingJobId}, but it could not be started — ` +
			`autonomous coding may be unavailable on this platform.${note}`
		);
	}
	return `Started coding job ${codingJobId} (run ${codingRunId}) against ${specPath}.${note}`;
}

export async function runAssetGenerationPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId, abort } = ctx;
	const startedAt = Date.now();
	const cfg = parseAssetGenerationConfig(job.type_config);
	const specPath = resolveSpecPath(cfg);
	// A chained run is unattended, whatever the config says. This keys on the
	// TRIGGER, not on the stored mode: a hand-edited config must not be able to
	// park an overnight chain on the anchor approval modal until morning.
	const attended = ctx.trigger !== 'chained' && cfg.run_mode === 'attended';
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
		let anchor: AnchorOutcome | null = null;
		let entries: EntryOutcome[] = [];

		startStep(ANCHOR);
		abortIfCancelled();
		const anchored = await establishAnchor(
			spec,
			{
				workingDir: job.working_dir,
				profile: spec.normalize,
				anchorAttempts: cfg.anchor_attempts ?? DEFAULT_ANCHOR_ATTEMPTS,
				attended,
				signal: abort.signal,
				present: (markdown) => ctx.patchStep(ANCHOR, { streaming: markdown }),
				readFile: (rel) => readWorkdirFile(ctx, rel),
				readBytes: (rel) => readWorkdirBytes(ctx, rel),
				writeFile: (rel, content) => writeWorkdirFile(ctx, rel, content),
				writeBytes: (rel, bytes) => writeWorkdirBytes(ctx, rel, bytes)
			},
			MAX_GENERATION_EDGE
		);
		anchor = anchored.outcome;
		const priorPalette = spec.normalize.palette ?? [];
		spec = anchored.spec;
		// The palette now lives in the spec, so it is versioned with the
		// entries it governs and a later run inherits it without asking.
		//
		// Only when it actually changed, though. This file is the user's, and
		// a re-run that reuses the committed anchor would otherwise rewrite it
		// byte-for-byte every time — a dirty working tree on every run, in
		// their repo, saying nothing happened.
		const nextPalette = spec.normalize.palette ?? [];
		if (!samePalette(priorPalette, nextPalette)) {
			await writeWorkdirFile(ctx, specPath, renderAssetSpec(spec));
		}
		finishStep(
			ANCHOR,
			[
				anchor.source === 'reused'
					? `Reused the committed anchor at ${anchor.imagePath}`
					: `Generated a style anchor in ${anchor.attempts} attempt(s) → ${anchor.imagePath}`,
				`Palette: ${anchor.paletteSize} colour(s).`,
				anchor.approval === 'auto' ? 'Accepted automatically — nobody saw it.' : 'Approved.'
			].join('\n')
		);

		startStep(GENERATE);
		abortIfCancelled();
		const backend = resolveImageBackend();
		// Asked once per run, not per entry: a backend that changed its mind
		// mid-run would degrade half the set and not the other half, and the
		// report would be unable to say why they do not match.
		const caps = await backend.capabilities();
		const generated = await generateEntries(spec, {
			caps,
			anchor: anchored.image,
			concurrency: cfg.concurrency ?? DEFAULT_CONCURRENCY,
			maxEdge: MAX_GENERATION_EDGE,
			maxAttempts: cfg.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
			judge: {
				// Never fail an entry for a capability the user does not have.
				visionSupported: ctx.visionSupported(),
				enabled: cfg.vision_judge ?? DEFAULT_VISION_JUDGE,
				judge: (entry, image) => judgeAsset(ctx, spec, entry, image, anchored.image)
			},
			signal: abort.signal,
			generate: (req, opts) => backend.generate(req, opts),
			exists: (rel) => workdirPathExists(ctx, rel),
			writeBytes: (rel, bytes) => writeWorkdirBytes(ctx, rel, bytes),
			progress: (n, total, id) => ctx.patchStep(GENERATE, { streaming: `${n}/${total} — ${id}` })
		});
		entries = generated.map((g) => g.outcome);
		const tally = countByStatus(entries);
		finishStep(
			GENERATE,
			[
				`${tally.done} generated, ${tally.skipped} already present, ` +
					`${tally.failed} failed of ${entryCount}.`,
				...(degradedSummary(entries) ? [degradedSummary(entries)] : [])
			].join('\n')
		);

		startStep(REPORT);
		abortIfCancelled();
		const sheetPath = await writeContactSheet(ctx, spec, entries, specPath);
		await writeWorkdirFile(
			ctx,
			reportPath,
			renderAssetReport({
				spec,
				specPath,
				anchor,
				entries,
				reports: new Map(generated.map((g) => [g.outcome.id, g.report])),
				contactSheet: sheetPath,
				// Said once in the document, not once per entry.
				judgeSkipped: (cfg.vision_judge ?? DEFAULT_VISION_JUDGE) && !ctx.visionSupported(),
				startedAt,
				finishedAt: Date.now()
			})
		);
		const unresolved = entries.filter((e) => e.status === 'unresolved').length;
		finishStep(
			REPORT,
			[
				// The unresolved count leads: it is the only number in the report
				// that asks the user to do something.
				unresolved > 0
					? `${unresolved} asset(s) could not be produced — see ${reportPath}.`
					: 'Every asset passed.',
				`Report: ${reportPath}` + (sheetPath ? `, contact sheet: ${sheetPath}` : '')
			].join('\n')
		);

		startStep(HANDOFF);
		abortIfCancelled();
		finishStep(HANDOFF, await handoffToCoding(ctx, cfg, specPath, entries));

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
