/**
 * The creation stage: build every spec entry on the creation model.
 *
 * One entry at a time, in spec order: the model writes `<id>.js` and checks
 * it with `check_3d`, then `judgeModel` decides in code whether it is done.
 * Not done, the next turn gets the problems; out of rounds, the entry is
 * "needs work" with them, and the run goes on. Each turn is a fresh
 * conversation, so a repair message names the file to read back. Every
 * judged attempt is kept, and the best one is what stays (`attempts.ts`).
 */

import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { StepChecklistEntry } from '#lib/agent/jobs/runner.svelte.ts';
import { modelColumnsOf, type ChainModel, type ModelColumns } from '#lib/agent/jobs/chainModel.ts';
import type { ModelGenerationConfig } from '#lib/agent/jobs/types/model-generation/config.ts';
import {
	createEntryPrompt,
	createRepairPrompt,
	createSystemPrompt
} from '#lib/agent/jobs/types/model-generation/prompts.ts';
import { Attempts, type Attempt } from '#lib/agent/jobs/types/model-generation/attempts.ts';
import { modelLoadIo } from '#lib/agent/jobs/types/model-generation/io.ts';
import type { EntryState } from '#lib/agent/jobs/types/model-generation/state.ts';
import { DRAW_TEXTURE_TOOL } from '#lib/agent/tools/draw-texture.ts';
import type { ModelEntry, ModelSpec } from '#lib/models3d/spec/types.ts';

/** What a creation turn may use: the model's files and the checker. */
export const CREATE_TOOLS: readonly string[] = [
	'fs_read_text',
	'fs_list_dir',
	'fs_write_text',
	'fs_edit_text',
	'check_3d'
];

/** The creation turn's tools; the texture tool only with Allow textures on. */
export function createToolAllowlist(allowTextures: boolean): string[] {
	return allowTextures ? [...CREATE_TOOLS, DRAW_TEXTURE_TOOL] : [...CREATE_TOOLS];
}

/** A stage's model as a turn takes it, and as its step names it. */
export interface StageModel {
	/** The turn's `model`: undefined runs it on the job's own. */
	model: ModelColumns | undefined;
	label: string;
	vision: boolean;
	contextSize: number;
}

/** The stage's override, or the job's model when it has none. */
export function stageModel(ctx: JobRunContext, override: ChainModel | null): StageModel {
	const described = ctx.describeModel(override ?? modelColumnsOf(ctx.job));
	return { model: override ?? undefined, ...described };
}

const abortError = () => new DOMException('Aborted', 'AbortError');

/** One entry's line in the step's checklist. */
function checklistEntry(entry: ModelEntry, state: EntryState, rounds: number): StepChecklistEntry {
	switch (state.status) {
		case 'done':
			return { label: entry.title, status: 'done' };
		case 'needs_work':
			return { label: entry.title, status: 'blocked', detail: 'needs work' };
		case 'skipped':
			return { label: entry.title, status: 'blocked', detail: 'skipped' };
		default:
			return state.rounds > 0
				? { label: entry.title, status: 'running', detail: `turn ${state.rounds + 1}/${rounds}` }
				: { label: entry.title, status: 'todo' };
	}
}

/** The step's checklist: one line per model, `running` marking the one being built. */
export function entryChecklist(
	spec: ModelSpec,
	states: EntryState[],
	rounds: number,
	running: string | null = null
): StepChecklistEntry[] {
	return spec.entries.map((entry, i) => {
		const line = checklistEntry(entry, states[i], rounds);
		return entry.id === running && line.status === 'todo' ? { ...line, status: 'running' } : line;
	});
}

/** "knight — done", one line per entry, for the step's output. */
export function entrySummary(spec: ModelSpec, states: EntryState[]): string {
	const word = { pending: 'not built', done: 'done', needs_work: 'needs work', skipped: 'skipped' };
	const lines = spec.entries.map((e, i) => {
		const s = states[i];
		const open = s.status === 'needs_work' && s.problems.length > 0 ? `: ${s.problems[0]}` : '';
		return `- ${e.id} — ${word[s.status]}${open}`;
	});
	const done = states.filter((s) => s.status === 'done').length;
	return [`${done} of ${states.length} model(s) done.`, '', ...lines].join('\n');
}

export interface BuildEntryInput {
	ctx: JobRunContext;
	cfg: ModelGenerationConfig;
	spec: ModelSpec;
	entry: ModelEntry;
	/** Updated in place as the rounds go. */
	state: EntryState;
	/** The step the turns stream into. */
	stepIndex: number;
	/** The first round's message; later rounds get the repair message. */
	firstMessage: string;
	/** Called after each round, for the checklist. */
	onRound?: () => void;
}

/**
 * A stage turn's `endTurnWhen`: after a tool batch that ran `check_3d`, judge
 * the entry as the stage will once the turn ends, and end the turn when it
 * passes. Without it a model that has passed keeps polishing until its
 * iteration cap. A judge that throws (or a cancel) doesn't end the turn here;
 * the loop and the stage handle both.
 */
export function endWhenPassing(passes: () => Promise<boolean>) {
	return async (calls: readonly { name: string }[]): Promise<boolean> => {
		if (!calls.some((c) => c.name === 'check_3d')) return false;
		try {
			return await passes();
		} catch {
			return false;
		}
	};
}

/**
 * Build one entry: up to `cfg.rounds` turns, each judged in code. Resets
 * the entry's rounds, so a rebuild after review counts afresh. Writes the
 * GLB and sheet of every build that passed the check, so out of rounds the
 * last good one is what stays on disk.
 */
export async function buildEntry(input: BuildEntryInput): Promise<void> {
	const { ctx, cfg, spec, entry, state, stepIndex } = input;
	const workdir = ctx.job.working_dir;
	if (!workdir) throw new Error('No working directory.');
	const io = modelLoadIo(workdir);
	const target = stageModel(ctx, cfg.create_model);
	const systemPrompt = createSystemPrompt(spec, cfg.allow_textures);
	const toolAllowlist = createToolAllowlist(cfg.allow_textures);

	state.status = 'pending';
	state.rounds = 0;
	// A rebuild after review starts a new best: the user turned the old one down.
	const attempts = new Attempts({
		workdir,
		entry,
		stage: 'create',
		start: state.attempts,
		signal: ctx.abort.signal,
		io
	});
	const judge = async (): Promise<Attempt | null> => {
		const a = await attempts.judge();
		state.attempts = attempts.count;
		if (a?.kept) {
			state.kept = a.n;
			state.glb ||= a.verdict.glb !== null;
			if (a.verdict.sheetPng) state.sheet = a.verdict.sheetPng;
			state.warnings = a.warnings;
		}
		return a;
	};
	let problems: string[] = [];
	while (state.rounds < cfg.rounds) {
		if (ctx.abort.signal.aborted) throw abortError();
		await ctx.runJobTurn({
			turnKind: 'models.create',
			userMessage: state.rounds === 0 ? input.firstMessage : createRepairPrompt(entry, problems),
			contextSize: target.contextSize,
			maxIterations: cfg.create_turns,
			systemPrompt,
			toolAllowlist,
			// Writes outside the model's own folder are refused.
			writeRoot: entry.dir,
			model: target.model,
			endTurnWhen: endWhenPassing(async () => (await judge())?.done ?? false),
			...ctx.buildStreamCallbacks(stepIndex)
		});
		state.rounds++;

		// The repair message gets what this turn left; the entry keeps its best.
		const last = await judge();
		problems = last ? last.problems : [`No ${entry.id}.js was written.`];
		input.onRound?.();
		if (last?.done) break;
	}
	const best = await attempts.finish();
	state.problems = best ? best.problems : problems;
	state.status = best?.done ? 'done' : 'needs_work';
}

/**
 * Build every entry, in spec order, one at a time. Patches the step's
 * description with the creation model and its checklist as entries finish.
 */
export async function createStage(
	ctx: JobRunContext,
	cfg: ModelGenerationConfig,
	spec: ModelSpec,
	states: EntryState[],
	stepIndex: number
): Promise<void> {
	const target = stageModel(ctx, cfg.create_model);
	ctx.patchStep(stepIndex, {
		description: `Build every model · ${target.label}`,
		checklist: entryChecklist(spec, states, cfg.rounds)
	});
	for (const [i, entry] of spec.entries.entries()) {
		if (ctx.abort.signal.aborted || !ctx.isLive()) throw abortError();
		const publish = () =>
			ctx.patchStep(stepIndex, { checklist: entryChecklist(spec, states, cfg.rounds, entry.id) });
		publish();
		await buildEntry({
			ctx,
			cfg,
			spec,
			entry,
			state: states[i],
			stepIndex,
			firstMessage: createEntryPrompt(entry),
			onRound: publish
		});
		publish();
	}
}
