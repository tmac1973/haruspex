/**
 * The animation stage: clips for every built model that needs them, on the
 * animation model.
 *
 * The animator writes `<id>.anim.js` beside the build module and checks each
 * clip with `check_3d`; `judgeModel` decides in code whether the clips are
 * done. The build module is creation's: it is hashed before the first turn,
 * and a turn that changes it has it put back and is told so.
 */

import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { StepChecklistEntry } from '#lib/agent/jobs/runner.svelte.ts';
import type { ModelGenerationConfig } from '#lib/agent/jobs/types/model-generation/config.ts';
import { stageModel } from '#lib/agent/jobs/types/model-generation/create.ts';
import {
	animateEntryPrompt,
	animateRepairPrompt,
	animateSystemPrompt
} from '#lib/agent/jobs/types/model-generation/prompts.ts';
import {
	modelFileExists,
	modelLoadIo,
	writeModelBytes,
	writeSheetPng
} from '#lib/agent/jobs/types/model-generation/io.ts';
import type { ClipsState, EntryState } from '#lib/agent/jobs/types/model-generation/state.ts';
import { judgeModel } from '#lib/glb/verdict.ts';
import { modelFiles } from '#lib/models3d/spec/paths.ts';
import type { ModelEntry, ModelSpec } from '#lib/models3d/spec/types.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { normalizeAbort } from '#lib/utils/error.ts';

/** What an animation turn may use: the model's files and the checker. */
export const ANIMATE_TOOLS: readonly string[] = [
	'fs_read_text',
	'fs_list_dir',
	'fs_write_text',
	'fs_edit_text',
	'check_3d'
];

const abortError = () => new DOMException('Aborted', 'AbortError');

/** Whether the stage animates this entry: built, kept, and with clips to make. */
export function wantsClips(entry: ModelEntry, state: EntryState): boolean {
	return entry.clips.length > 0 && state.status !== 'skipped' && state.glb;
}

async function sha256(bytes: Uint8Array): Promise<string> {
	// A fresh buffer: `digest` refuses a view onto a shared one.
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
	return bytesToBase64(new Uint8Array(digest));
}

async function readBytes(workdir: string, relPath: string): Promise<Uint8Array> {
	return new Uint8Array(await modelLoadIo(workdir).read(relPath));
}

/** The animated entries' lines in the step's checklist. */
export function clipsChecklist(
	spec: ModelSpec,
	states: EntryState[],
	rounds: number,
	running: string | null
): StepChecklistEntry[] {
	return spec.entries.flatMap((entry, i): StepChecklistEntry[] => {
		const clips = states[i].clips;
		if (!wantsClips(entry, states[i])) return [];
		if (clips?.status === 'done') return [{ label: entry.title, status: 'done' }];
		if (clips?.status === 'needs_work') {
			return [{ label: entry.title, status: 'blocked', detail: 'needs work' }];
		}
		if (entry.id !== running) return [{ label: entry.title, status: 'todo' }];
		const round = (clips?.rounds ?? 0) + 1;
		return [{ label: entry.title, status: 'running', detail: `turn ${round}/${rounds}` }];
	});
}

interface AnimateEntryInput {
	ctx: JobRunContext;
	cfg: ModelGenerationConfig;
	entry: ModelEntry;
	state: EntryState;
	stepIndex: number;
	onRound?: () => void;
}

/**
 * Animate one entry: up to `cfg.rounds` turns, each judged in code. The GLB
 * on disk is replaced only by a build that passed the check, so out of
 * rounds it is the last one that built, or creation's when none did.
 */
export async function animateEntry(input: AnimateEntryInput): Promise<void> {
	const { ctx, cfg, entry, state, stepIndex } = input;
	const workdir = ctx.job.working_dir;
	if (!workdir) throw new Error('No working directory.');
	const files = modelFiles(entry);
	const target = stageModel(ctx, cfg.animate_model);
	const original = await readBytes(workdir, files.build);
	const hash = await sha256(original);
	const clips: ClipsState = { status: 'pending', problems: [], rounds: 0, sheets: [] };
	state.clips = clips;
	const firstMessage = animateEntryPrompt(entry, new TextDecoder().decode(original));

	while (clips.rounds < cfg.rounds) {
		if (ctx.abort.signal.aborted) throw abortError();
		await ctx.runJobTurn({
			turnKind: 'models.animate',
			userMessage: clips.rounds === 0 ? firstMessage : animateRepairPrompt(entry, clips.problems),
			contextSize: target.contextSize,
			maxIterations: cfg.animate_turns,
			systemPrompt: animateSystemPrompt(),
			toolAllowlist: [...ANIMATE_TOOLS],
			writeRoot: entry.dir,
			model: target.model,
			...ctx.buildStreamCallbacks(stepIndex)
		});
		clips.rounds++;

		const problems: string[] = [];
		const now = await readBytes(workdir, files.build).catch(() => null);
		if (now === null || (await sha256(now)) !== hash) {
			await writeModelBytes(workdir, files.build, original);
			problems.push(
				`${entry.id}.js was changed; it was put back. Change only ${entry.id}.anim.js.`
			);
		}
		if (!(await modelFileExists(workdir, files.anim))) {
			problems.push(`No ${entry.id}.anim.js was written.`);
		} else {
			problems.push(...(await judgeAndKeep(input, workdir)));
		}
		clips.problems = problems;
		if (problems.length === 0) {
			clips.status = 'done';
			input.onRound?.();
			return;
		}
		input.onRound?.();
	}
	clips.status = 'needs_work';
	state.status = 'needs_work';
}

/** Judge the animated build and write what passed the check; its problems. */
async function judgeAndKeep(input: AnimateEntryInput, workdir: string): Promise<string[]> {
	const { ctx, entry, state } = input;
	const files = modelFiles(entry);
	const clips = state.clips!;
	try {
		const verdict = await judgeModel({
			entry,
			files,
			stage: 'animate',
			io: modelLoadIo(workdir),
			signal: ctx.abort.signal
		});
		if (verdict.glb) await writeModelBytes(workdir, files.glb, verdict.glb);
		for (const [name, png] of Object.entries(verdict.clipSheets)) {
			if (await writeSheetPng(workdir, files.clipSheet(name), png)) {
				if (!clips.sheets.includes(name)) clips.sheets.push(name);
			}
		}
		state.warnings = verdict.warnings;
		return verdict.done ? [] : verdict.problems;
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		if (aborted || ctx.abort.signal.aborted) throw abortError();
		return [`The check could not run: ${msg}`];
	}
}

/**
 * Animate every entry that wants clips, in spec order, one at a time. The
 * rest pass through untouched.
 */
export async function animateStage(
	ctx: JobRunContext,
	cfg: ModelGenerationConfig,
	spec: ModelSpec,
	states: EntryState[],
	stepIndex: number
): Promise<void> {
	const target = stageModel(ctx, cfg.animate_model);
	const publish = (running: string | null) =>
		ctx.patchStep(stepIndex, {
			checklist: clipsChecklist(spec, states, cfg.rounds, running)
		});
	ctx.patchStep(stepIndex, {
		description: `Animate the models with clips · ${target.label}`
	});
	publish(null);
	for (const [i, entry] of spec.entries.entries()) {
		if (!wantsClips(entry, states[i])) continue;
		if (ctx.abort.signal.aborted || !ctx.isLive()) throw abortError();
		publish(entry.id);
		await animateEntry({
			ctx,
			cfg,
			entry,
			state: states[i],
			stepIndex,
			onRound: () => publish(entry.id)
		});
		publish(null);
	}
}

/** "2 of 2 animated model(s) done.", or why nothing was animated. */
export function clipsSummary(spec: ModelSpec, states: EntryState[]): string {
	const animated = states.filter((s) => s.clips !== null);
	if (animated.length === 0) return 'Skipped — no built model has clips.';
	const done = animated.filter((s) => s.clips?.status === 'done').length;
	const lines = spec.entries.flatMap((e, i) => {
		const c = states[i].clips;
		if (!c) return [];
		const open = c.status === 'needs_work' && c.problems.length > 0 ? `: ${c.problems[0]}` : '';
		return [`- ${e.id} — ${c.status === 'done' ? 'done' : 'needs work'}${open}`];
	});
	return [`${done} of ${animated.length} animated model(s) done.`, '', ...lines].join('\n');
}
