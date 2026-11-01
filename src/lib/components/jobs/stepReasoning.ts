import { splitThinkChannels } from '#lib/markdown.ts';
import type { RunStepState } from '#lib/agent/jobs/runner.svelte.ts';

/** How `onReasoning` separates one model call's reasoning from the next. */
const CALL_BREAK = '\n\n---\n\n';

/**
 * Reasoning already banked for the step, plus whatever is in flight.
 * `onReasoning` only fires when a model call completes, so on a streaming
 * turn the tail is the difference between watching and waiting; on a
 * tool-driven one there is no tail and this is just the banked text.
 *
 * `streaming` keeps a call's text after `onReasoning` has banked it, until
 * the next call streams over it, and for good once the step ends: so a tail
 * the banked text already ends with is that call, not a new one.
 */
export function stepReasoning(step: Pick<RunStepState, 'status' | 'reasoning' | 'streaming'>) {
	if (step.status !== 'running') return step.reasoning;
	const live = splitThinkChannels(step.streaming).reasoning.trim();
	if (!live || step.reasoning.trim().endsWith(live)) return step.reasoning;
	return step.reasoning ? `${step.reasoning}${CALL_BREAK}${live}` : live;
}
