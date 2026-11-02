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
import { PROJECT_READ_TOOLS } from '#lib/agent/jobs/readTools.ts';
import { createJob } from '#lib/stores/jobs.svelte.ts';
import { modelColumnsOf } from '#lib/agent/jobs/chainModel.ts';
import { normalizeAbort } from '#lib/utils/error.ts';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted,
	type JobRunStepStatus
} from '#lib/stores/jobRuns.svelte.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { RunStatus } from '#lib/agent/jobs/runner.svelte.ts';
import type { AssetGenerationConfig } from '#lib/agent/jobs/types/asset-generation/config.ts';
import {
	parseAssetGenerationConfig,
	resolveSpecPath,
	DEFAULT_ANCHOR_ATTEMPTS,
	DEFAULT_CONCURRENCY,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_TARGET_SIZE,
	DEFAULT_VISION_JUDGE,
	MAX_GENERATION_EDGE
} from '#lib/agent/jobs/types/asset-generation/config.ts';
import { parseAssetSpec } from '#lib/assets/spec/parse.ts';
import { renderAssetSpec } from '#lib/assets/spec/write.ts';
import { markRejections } from '#lib/agent/jobs/types/asset-generation/review.ts';
import { validateAssetSpec } from '#lib/assets/spec/validate.ts';
import type { AssetSpec } from '#lib/assets/spec/types.ts';
import { contactSheet, defaultProfile } from '#lib/assets/normalize.ts';
import {
	renderTexture,
	renderTransition,
	groundPreview,
	tiledPreview,
	transitionPreview,
	validateRecipe,
	validateTransitionEdge
} from '#lib/assets/texture.ts';
import {
	applyTransitions,
	runTransition,
	type TransitionOutcome
} from '#lib/agent/jobs/types/asset-generation/transitions.ts';
import { resolveImageBackend, routedImageBackend } from '#lib/image/index.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { drawingEntry } from '#lib/image/route.ts';
import { SUBMIT_ASSET_SPEC_TOOL } from '#lib/agent/tools/coding.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import { deriveSpec, type DerivePayload } from '#lib/agent/jobs/types/asset-generation/derive.ts';
import {
	judgePrompt,
	SIDE_HINT,
	specDerivationPrompt,
	specRetryPrompt,
	TRANSITION_HINT
} from '#lib/agent/jobs/types/asset-generation/prompts.ts';
import { establishAnchor } from '#lib/agent/jobs/types/asset-generation/anchor.ts';
import { checkGround, groundOf } from '#lib/agent/jobs/types/asset-generation/ground.ts';
import type { SpriteTone } from '#lib/ipc/gen/SpriteTone.ts';
import {
	parseJudgement,
	parseSubmitted,
	SUBMIT_ASSET_JUDGEMENT_TOOL,
	SUBMIT_TEXTURE_RECIPES_TOOL,
	type AssetJudgement,
	type Submitted
} from '#lib/agent/jobs/types/asset-generation/tools.ts';
import {
	applyCodeTextures,
	reviseEdge,
	reviseRecipe,
	writeRecipes,
	type RecipeDeps
} from '#lib/agent/jobs/types/asset-generation/recipes.ts';
import { DEFAULT_TEXTURE_VARIANTS } from '#lib/agent/jobs/types/asset-generation/config.ts';
import type { AssetEntry, TransitionEntry } from '#lib/assets/spec/types.ts';
import { generateEntries } from '#lib/agent/jobs/types/asset-generation/generate.ts';
import { fitStyle } from '#lib/agent/jobs/types/asset-generation/promptBudget.ts';
import {
	applyJobSize,
	nativeEdgeFor,
	upscaleForEdge
} from '#lib/agent/jobs/types/asset-generation/nativeEdge.ts';
import {
	countByStatus,
	renderAssetReport,
	type Licensing
} from '#lib/agent/jobs/types/asset-generation/report.ts';
import type {
	AnchorOutcome,
	EntryOutcome,
	SheetOutcome
} from '#lib/agent/jobs/types/asset-generation/types.ts';
import { pngDataUrl as dataUrl } from '#lib/utils/base64.ts';

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

/**
 * What is known about the licence of everything that shaped this run.
 *
 * The catalogue is the only thing that can answer for a checkpoint, and it
 * only answers for one Haruspex downloaded. A hand-placed file, or whatever
 * ComfyUI has configured, is reported as unknown rather than given the
 * benefit of the doubt — and any LoRA the spec named is unknown regardless,
 * because a LoRA carries its own terms and Haruspex cannot classify a file
 * the user supplied.
 */
async function resolveLicensing(spec: AssetSpec): Promise<Licensing> {
	const loras = (spec.style.loras ?? []).map((l) => l.name).filter((n) => n.trim().length > 0);
	// Named even when the spec leaves it to the backend: "the configured
	// default" tells a reader nothing about what made their art.
	const model = (spec.style.model ?? '').trim() || configuredModelName();
	try {
		const catalogue =
			await invoke<Array<{ id: string; filename: string; license: string; description: string }>>(
				'image_models'
			);
		const match = catalogue.find(
			(m) => m.id === model || m.filename === model || model.endsWith(m.filename)
		);
		if (match) {
			return { modelName: match.description, modelLicense: match.license, loras };
		}
	} catch {
		// No catalogue is not a reason to claim a licence.
	}
	return {
		modelName: model || "the backend's configured default",
		modelLicense: null,
		loras
	};
}

/** The model a drawing goes to when a spec names none. */
function configuredModelName(): string {
	const entry = drawingEntry();
	if (!entry) return '';
	// A bundled-engine setup from before catalogue ids named a file.
	if (entry.backend === 'local' && !entry.model) return getSettings().imageLocalModelPath.trim();
	return entry.model;
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

/** The stage line for sheets: how many cut exactly leads, as in the report. */
function sheetSummary(sheets: SheetOutcome[]): string {
	const exact = sheets.filter((s) => s.exact).length;
	const keyed = sheets.filter((s) => s.keyed).length;
	return (
		`Sheets: ${exact} of ${sheets.length} cut exactly` +
		(keyed > 0 ? `, ${keyed} keyed from an opaque backdrop` : '') +
		'.'
	);
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
	anchor: Uint8Array,
	hint?: string
): Promise<AssetJudgement | null> {
	return judgeImage(
		ctx,
		judgePrompt(entry.prompt, spec.style.prompt, entry.kind, hint),
		image,
		anchor
	);
}

/** A transition set's judging turn: the anchor, and the set laid out as a map. */
function judgeTransition(
	ctx: JobRunContext,
	spec: AssetSpec,
	t: TransitionEntry,
	image: Uint8Array,
	anchor: Uint8Array
): Promise<AssetJudgement | null> {
	const name = (id: string | undefined) => {
		const e = spec.entries.find((x) => x.id === id);
		return e?.drawn || e?.prompt || id || '';
	};
	const subject =
		t.view === 'top'
			? `${name(t.a)} meeting ${name(t.b)}, as edge tiles`
			: `platform ground of ${name(t.a)}${t.cap ? ` with ${name(t.cap)} on top` : ''}`;
	const hint = TRANSITION_HINT + (t.view === 'side' ? SIDE_HINT : '');
	return judgeImage(ctx, judgePrompt(subject, spec.style.prompt, undefined, hint), image, anchor);
}

async function judgeImage(
	ctx: JobRunContext,
	userMessage: string,
	image: Uint8Array,
	anchor: Uint8Array
): Promise<AssetJudgement | null> {
	let verdict: AssetJudgement | null = null;
	await ctx.runJobTurn({
		userMessage,
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
 * Draw the spec's transition sets, after its textures: each from its
 * materials' recipes, judged as a small map when a judge will look. The spec
 * with revised edges and rejection marks, when anything changed.
 */
async function drawTransitions(
	ctx: JobRunContext,
	spec: AssetSpec,
	opts: { tileSize: number; anchor: Uint8Array; judging: boolean; signal: AbortSignal }
): Promise<{ spec: AssetSpec | null; outcomes: TransitionOutcome[] }> {
	const outcomes: TransitionOutcome[] = [];
	const { tileSize, anchor } = opts;
	for (const t of spec.transitions ?? []) {
		ctx.patchStep(GENERATE, { streaming: `Drawing transition set ${t.id}…` });
		outcomes.push(
			await runTransition(t, {
				spec,
				tileSize,
				signal: opts.signal,
				exists: (rel) => workdirPathExists(ctx, rel),
				writeBytes: (rel, bytes) => writeWorkdirBytes(ctx, rel, bytes),
				writeText: (rel, text) => writeWorkdirFile(ctx, rel, text),
				render: (view, a, other, edge, seeds) =>
					renderTransition(view, a, other, edge, tileSize, seeds, []),
				preview: (view, sheet) => transitionPreview(view, sheet, tileSize),
				judge: opts.judging ? (set, image) => judgeTransition(ctx, spec, set, image, anchor) : null,
				revise: (set, reason, preview) => reviseEdge(set, reason, recipeDeps(ctx), preview)
			})
		);
	}
	return { spec: applyTransitions(spec, outcomes), outcomes };
}

/** The step's line about transition sets, or none. */
function transitionSummary(
	spec: AssetSpec,
	outcomes: TransitionOutcome[],
	codeTextures: boolean
): string[] {
	if (!spec.transitions?.length) return [];
	if (!codeTextures) {
		return [
			'Transition sets were skipped: they are drawn from code-drawn textures (Draw textures in code).'
		];
	}
	const drawnSets = outcomes.filter((o) => o.status === 'done' || o.status === 'unresolved');
	return [`${drawnSets.length} transition set(s) drawn of ${outcomes.length}.`];
}

/** The recipe stage's model turn and Rust's check, for `recipes.ts`. */
function recipeDeps(ctx: JobRunContext, tone?: SpriteTone): RecipeDeps {
	return {
		visionSupported: ctx.visionSupported(),
		...(tone ? { tone } : {}),
		ask: async (prompt, image) => {
			let got: Submitted = { recipes: new Map(), edges: new Map() };
			await ctx.runJobTurn({
				userMessage: prompt,
				// A revision looks at the tiles the judge turned down.
				...(image
					? {
							history: [
								{
									role: 'user' as const,
									content: [{ type: 'image_url' as const, image_url: { url: dataUrl(image) } }]
								}
							]
						}
					: {}),
				contextSize: ctx.contextSize(),
				visionSupported: image !== undefined,
				toolAllowlist: [SUBMIT_TEXTURE_RECIPES_TOOL],
				forceFinalTool: SUBMIT_TEXTURE_RECIPES_TOOL,
				maxIterations: 1,
				turnKind: 'asset.recipes',
				onToolStart: (call: ResolvedToolCall) => {
					if (call.name === SUBMIT_TEXTURE_RECIPES_TOOL) got = parseSubmitted(call.arguments);
				}
			});
			return got;
		},
		validate: validateRecipe,
		validateEdge: validateTransitionEdge
	};
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
	if (!cfg.coding_run) {
		return 'Nothing chained — this run carried no coding configuration.';
	}
	if (ctx.trigger !== 'chained' && cfg.hand_off === false) {
		return 'Nothing chained — this run was started by hand, with the coding handoff off.';
	}

	// The coding run's preflight can see which art is missing, so it plans
	// around a gap instead of writing code that loads a file nobody made.
	const missing = entries.filter((e) => e.status !== 'done' && e.status !== 'skipped' && !e.kept);
	const note = missing.length
		? ` ${missing.length} asset(s) could not be produced and are NOT on disk: ` +
			`${missing.map((e) => e.id).join(', ')}.`
		: '';

	const codingJobId = await createJob({
		name: `${cfg.chain_base_name ?? job.name} — coding`,
		description:
			`Started automatically by asset-generation run ${runId}. ` +
			`The asset spec is at ${specPath}.${note}`,
		working_dir: job.working_dir,
		auto_approve_tools: true,
		schedule_kind: 'manual',
		schedule_config: null,
		next_due_at: null,
		job_type: 'autonomous_coding',
		parent_job_id: job.id,
		parent_run_id: runId,
		// The coding stage's model as the planning job resolved it, so an
		// asset-stage override never leaks into the code. A hand-made asset
		// job carries none and hands on its own.
		...(cfg.chain_coding_model ?? modelColumnsOf(job)),
		type_config: JSON.stringify({
			...cfg.coding_run,
			// Set here, not carried: this run is the thing that knows where the
			// spec ended up, and the preflight checks the plan's asset ids
			// against it.
			asset_spec_path: specPath,
			// Still listed in the spec, but no file was written.
			missing_assets: missing.map((e) => e.id)
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
			// The one thing the job overrides is the asset size, and it says so.
			const parsed = parseAssetSpec(json);
			if ('errors' in parsed) {
				throw new Error(`The spec at ${specPath} could not be read:\n${parsed.errors.join('\n')}`);
			}
			const problems = validateAssetSpec(parsed.spec);
			if (problems.length > 0) {
				throw new Error(`The spec at ${specPath} has problems:\n${problems.join('\n')}`);
			}
			spec = parsed.spec;
			let resized = '';
			if (cfg.target_size !== null) {
				const sized = applyJobSize(spec, cfg.target_size, await nativeEdgeFor(spec.style.model));
				if (sized.from !== null) {
					spec = sized.spec;
					await writeWorkdirFile(ctx, specPath, renderAssetSpec(spec));
					resized =
						`\nAsset size changed from ${sized.from} to ${cfg.target_size} px to match the job. ` +
						`Assets already on disk keep their old size; delete them to remake them.`;
				}
			}
			finishStep(
				SPEC,
				`${specPath} — ${spec.entries.length} asset(s): ${breakdown(spec)}${resized}`
			);
		} else {
			if (!cfg.description) {
				throw new Error(
					`No spec at ${specPath} and nothing to write one from — set a spec path that ` +
						`exists, or describe what to make.`
				);
			}
			// The upscale follows the MODEL, not a constant. Generation happens
			// at target_size * upscale, and SDXL produces artefacts below its
			// native 1024 just as SD1.5 degrades above its 512 — so a shipped
			// default of 16 silently halves SDXL's resolution and the user
			// discovers it by looking at bad sprites.
			const base = await defaultProfile();
			const edge = await nativeEdgeFor(undefined);
			const profile = {
				...base,
				target_size: targetSize,
				upscale: edge === null ? base.upscale : upscaleForEdge(targetSize, edge)
			};
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
					toolAllowlist: [...PROJECT_READ_TOOLS, SUBMIT_ASSET_SPEC_TOOL],
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

		// Asked once per run, not per entry: a backend that changed its mind
		// mid-run would degrade half the set and not the other half, and the
		// report would be unable to say why they do not match. Asked before
		// the anchor, because whether the anchor is a real sheet depends on it.
		const backend = routedImageBackend();
		const caps = await backend.capabilities();

		startStep(ANCHOR);
		abortIfCancelled();
		const anchored = await establishAnchor(
			spec,
			{
				workingDir: job.working_dir,
				profile: spec.normalize,
				anchorAttempts: cfg.anchor_attempts ?? DEFAULT_ANCHOR_ATTEMPTS,
				attended,
				runId: ctx.runId,
				signal: abort.signal,
				present: (markdown) => ctx.patchStep(ANCHOR, { streaming: markdown }),
				readFile: (rel) => readWorkdirFile(ctx, rel),
				readBytes: (rel) => readWorkdirBytes(ctx, rel),
				writeFile: (rel, content) => writeWorkdirFile(ctx, rel, content),
				writeBytes: (rel, bytes) => writeWorkdirBytes(ctx, rel, bytes),
				caps
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
		// Textures drawn in code need a recipe first, written by the model in
		// one turn for the whole set. Saved in the spec, so a re-run reuses them.
		const codeTextures = cfg.code_textures === true;
		const recipesFailed = new Map<string, string>();
		// The anchor's sprites, which every code-drawn tile must show them up on.
		const ground = codeTextures ? await groundOf(anchored.image, spec.normalize) : null;
		if (codeTextures) {
			ctx.patchStep(GENERATE, { streaming: 'Writing texture recipes…' });
			const rd = recipeDeps(ctx, ground?.tone);
			const r = await writeRecipes(spec, rd);
			for (const [id, why] of r.failed) recipesFailed.set(id, why);
			if (r.written.length > 0) {
				spec = r.spec;
				await writeWorkdirFile(ctx, specPath, renderAssetSpec(spec));
			}
			abortIfCancelled();
		}
		const variants = cfg.texture_variants ?? DEFAULT_TEXTURE_VARIANTS;
		// The renderer draws up to 256 px; a tile is never bigger in practice.
		const tileSize = Math.min(256, spec.normalize.target_size || DEFAULT_TARGET_SIZE);
		const sheets: SheetOutcome[] = [];
		const generated = await generateEntries(spec, {
			caps,
			concurrency: cfg.concurrency ?? DEFAULT_CONCURRENCY,
			maxEdge: MAX_GENERATION_EDGE,
			maxAttempts: cfg.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
			judge: {
				// Never fail an entry for a capability the user does not have.
				visionSupported: ctx.visionSupported(),
				enabled: cfg.vision_judge ?? DEFAULT_VISION_JUDGE,
				judge: (entry, image, hint) => judgeAsset(ctx, spec, entry, image, anchored.image, hint)
			},
			signal: abort.signal,
			generate: (req, opts) => backend.generate(req, opts),
			exists: (rel) => workdirPathExists(ctx, rel),
			writeBytes: (rel, bytes) => writeWorkdirBytes(ctx, rel, bytes),
			progress: (n, total, id) => ctx.patchStep(GENERATE, { streaming: `${n}/${total} — ${id}` }),
			onSheet: (o) => sheets.push(o),
			pregenerated: anchored.pregenerated
				? new Map([[anchored.pregenerated.sheetId, anchored.pregenerated.result]])
				: undefined,
			codeTextures: codeTextures
				? {
						variants,
						// The recipe chooses its colours from the set's (the prompt
						// offers them); not snapped to the palette, which comes from
						// a sheet of sprites and can lack water blue or grass green.
						render: (recipe, seed, n) => renderTexture(recipe, tileSize, seed, n, []),
						preview: (tile) =>
							ground ? groundPreview(tile, tileSize, ground.sprites) : tiledPreview(tile, tileSize),
						withSprites: ground !== null,
						...(ground ? { contrast: (tile: Uint8Array) => checkGround(tile, ground) } : {}),
						revise: (entry, reason, preview) =>
							reviseRecipe(spec, entry, reason, recipeDeps(ctx, ground?.tone), preview),
						recipeFailures: recipesFailed
					}
				: undefined
		});
		entries = generated.map((g) => g.outcome);
		// Kept-but-rejected entries are marked in the spec, for Review assets
		// and for the coding run; ones accepted this time are unmarked.
		const drawn = applyCodeTextures(spec, entries);
		const marked = markRejections(drawn ?? spec, entries);
		if (marked || drawn) {
			spec = marked ?? drawn!;
			await writeWorkdirFile(ctx, specPath, renderAssetSpec(spec));
		}
		// Sets are drawn from code-drawn textures' recipes, after them.
		const sets = codeTextures
			? await drawTransitions(ctx, spec, {
					tileSize,
					anchor: anchored.image,
					judging: ctx.visionSupported() && (cfg.vision_judge ?? DEFAULT_VISION_JUDGE),
					signal: abort.signal
				})
			: { spec: null, outcomes: [] };
		if (sets.spec) {
			spec = sets.spec;
			await writeWorkdirFile(ctx, specPath, renderAssetSpec(spec));
		}
		const tally = countByStatus(entries);
		finishStep(
			GENERATE,
			[
				`${tally.done} generated, ${tally.skipped} already present, ` +
					`${tally.failed} failed of ${entryCount}.`,
				...(codeTextures && entries.some((e) => e.codeDrawn)
					? [
							`${entries.filter((e) => e.codeDrawn).length} texture(s) drawn in code, ` +
								`${variants} tile(s) each.`
						]
					: []),
				...transitionSummary(spec, sets.outcomes, codeTextures),
				...(sheets.length > 0 ? [sheetSummary(sheets)] : []),
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
				transitions: sets.outcomes,
				reports: new Map(generated.map((g) => [g.outcome.id, g.report])),
				sheets,
				contactSheet: sheetPath,
				// Said once in the document, not once per entry.
				judgeSkipped: (cfg.vision_judge ?? DEFAULT_VISION_JUDGE) && !ctx.visionSupported(),
				licensing: await resolveLicensing(spec),
				styleTruncated: fitStyle(spec.style.prompt).truncated,
				sizing: {
					edge: Math.min(spec.normalize.target_size * spec.normalize.upscale, MAX_GENERATION_EDGE),
					nativeEdge: await nativeEdgeFor(spec.style.model)
				},
				startedAt,
				finishedAt: Date.now()
			})
		);
		// Failed (the backend or a write gave up) and unresolved (never passed
		// its checks) are both assets the run did not produce.
		const missing = entries.filter(
			(e) => (e.status === 'unresolved' || e.status === 'failed') && !e.kept
		).length;
		const kept = entries.filter((e) => e.kept).length;
		finishStep(
			REPORT,
			[
				// The missing count leads: it is the only number in the report
				// that asks the user to do something.
				missing > 0
					? `${missing} asset(s) could not be produced — see ${reportPath}.`
					: kept > 0
						? 'Every asset is on disk.'
						: 'Every asset passed.',
				...(kept > 0
					? [`${kept} kept despite failing their checks — marked for Review assets.`]
					: []),
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
