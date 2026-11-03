/**
 * The attended review: after creation, before animation, the user looks at
 * each model's render sheet and keeps it, skips it, or types a note to have
 * it rebuilt. Every answer is collected first, so the user is not kept
 * waiting on a build between questions; then the noted models are rebuilt
 * and shown again, until every answer is Keep or Skip it.
 */

import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { ModelGenerationConfig } from '#lib/agent/jobs/types/model-generation/config.ts';
import { buildEntry, entryChecklist } from '#lib/agent/jobs/types/model-generation/create.ts';
import { createEntryPrompt } from '#lib/agent/jobs/types/model-generation/prompts.ts';
import type { EntryState } from '#lib/agent/jobs/types/model-generation/state.ts';
import type { ModelEntry, ModelSpec } from '#lib/models3d/spec/types.ts';
import { askUserQuestion, type UserQuestionRequest } from '#lib/stores/userQuestion.svelte.ts';

export const KEEP = 'Keep';
export const SKIP = 'Skip it';

/**
 * Whether this run stops for the review: Attended, and started by a person.
 * A chained run has nobody waiting on it, the 2D job's rule.
 */
export function isAttended(ctx: JobRunContext, cfg: ModelGenerationConfig): boolean {
	return ctx.trigger !== 'chained' && cfg.run_mode === 'attended';
}

/** The question for one model: its sheet, and its open problems when it needs work. */
export function reviewQuestion(
	runId: number,
	entry: ModelEntry,
	state: EntryState
): UserQuestionRequest {
	return {
		runId,
		question: `${entry.title}: keep this model?`,
		body:
			state.status === 'needs_work' && state.problems.length > 0
				? ['Open problems:', '', ...state.problems.map((p) => `- ${p}`)].join('\n')
				: undefined,
		imageUrl: state.sheet ?? undefined,
		options: [
			{ label: KEEP, recommended: true },
			{ label: SKIP, description: 'Leave it out of animation and the report marks it skipped.' }
		]
	};
}

/** What one answer asks for. */
type Verdict = { kind: 'keep' } | { kind: 'skip' } | { kind: 'rebuild'; note: string };

/**
 * Ask about every entry in `indices`, in order. A typed answer is a rebuild
 * note; an empty one keeps the model. An answer we did not offer ends the
 * run rather than guess, as the 2D anchor checkpoint does; Stop or a
 * dismissed modal reject with AbortError on their own.
 */
async function askAll(
	ctx: JobRunContext,
	spec: ModelSpec,
	states: EntryState[],
	indices: number[]
): Promise<Map<number, Verdict>> {
	const out = new Map<number, Verdict>();
	for (const i of indices) {
		const answer = await askUserQuestion(
			reviewQuestion(ctx.runId, spec.entries[i], states[i]),
			ctx.abort.signal
		);
		if (answer.kind === 'freeText') {
			const note = answer.text.trim();
			out.set(i, note ? { kind: 'rebuild', note } : { kind: 'keep' });
		} else if (answer.labels[0] === KEEP) {
			out.set(i, { kind: 'keep' });
		} else if (answer.labels[0] === SKIP) {
			out.set(i, { kind: 'skip' });
		} else {
			throw new DOMException('Aborted', 'AbortError');
		}
	}
	return out;
}

/**
 * Review every built model, rebuilding the noted ones with their note, until
 * nothing is left to rebuild. A rebuild gets `cfg.rounds` fresh rounds and
 * the creation stage's system prompt; only the models rebuilt are asked
 * about again. Runs under the creation step, whose checklist it updates.
 */
export async function reviewStage(
	ctx: JobRunContext,
	cfg: ModelGenerationConfig,
	spec: ModelSpec,
	states: EntryState[],
	stepIndex: number
): Promise<void> {
	let indices = states.map((_, i) => i).filter((i) => states[i].status !== 'skipped');
	while (indices.length > 0) {
		const verdicts = await askAll(ctx, spec, states, indices);
		const rebuild: number[] = [];
		for (const [i, v] of verdicts) {
			if (v.kind === 'skip') states[i].status = 'skipped';
			if (v.kind === 'rebuild') {
				states[i].note = v.note;
				rebuild.push(i);
			}
		}
		const publish = (running: string | null) =>
			ctx.patchStep(stepIndex, { checklist: entryChecklist(spec, states, cfg.rounds, running) });
		publish(null);
		for (const i of rebuild) {
			const entry = spec.entries[i];
			publish(entry.id);
			await buildEntry({
				ctx,
				cfg,
				spec,
				entry,
				state: states[i],
				stepIndex,
				firstMessage: createEntryPrompt(entry, states[i].note),
				onRound: () => publish(entry.id)
			});
			publish(null);
		}
		indices = rebuild;
	}
}
