/**
 * Shared core for the non-chat turn drivers (shell tab, ephemeral/jobs).
 *
 * Both previously repeated the same scaffolding around `runAgentLoop`:
 * accumulate streamed deltas (with `<think>` handling), derive the final
 * assistant text on completion, capture any loop error and rethrow it after
 * the loop settles. That lives here once; callers supply the fully-built loop
 * options plus how to finalize the streamed text.
 *
 * The chat store keeps its own `onComplete` (citations, partial-on-abort
 * commit, diagnostics) and is intentionally NOT routed through this.
 */

import { runAgentLoop, type AgentLoopOptions, type AgentStopReason } from '$lib/agent/loop';
import { appendStreamDelta, createThinkStreamState } from '$lib/agent/think-stream';
import { ResponseCutOffError } from '$lib/api';

/** Loop options minus the streaming/lifecycle callbacks `runTurnCore` owns. */
export type TurnLoopOptions = Omit<AgentLoopOptions, 'onStreamChunk' | 'onComplete' | 'onError'>;

export interface TurnHooks {
	/** Called with the full accumulated text on each streaming delta. */
	onAssistantDelta?: (full: string) => void;
	/** Turn the raw accumulated stream into the final assistant text. */
	finalize: (raw: string) => string;
	/**
	 * Return an answer cut off at the response cap, with `cutOff` saying so,
	 * instead of throwing. For a caller that is better served by a partial
	 * answer than by none.
	 */
	keepCutOffAnswer?: boolean;
}

export async function runTurnCore(
	loop: TurnLoopOptions,
	hooks: TurnHooks
): Promise<{ finalText: string; rawText: string; stopReason: AgentStopReason; cutOff?: string }> {
	let streamingContent = '';
	const thinkState = createThinkStreamState();
	let finalText = '';
	// The unstripped buffer. `finalText` has reasoning removed so callers can
	// pattern-match on it; `rawText` keeps `<think>` blocks for the UI to render.
	let rawText = '';
	let stopReason: AgentStopReason = 'complete';
	let runError: Error | null = null;

	await runAgentLoop({
		...loop,
		onStreamChunk: (chunk) => {
			streamingContent = appendStreamDelta(streamingContent, chunk.delta, thinkState);
			hooks.onAssistantDelta?.(streamingContent);
		},
		onComplete: (meta) => {
			finalText = hooks.finalize(streamingContent);
			rawText = streamingContent;
			stopReason = meta?.stopReason ?? 'complete';
		},
		onError: (err) => {
			runError = err;
		}
	});

	if (runError) {
		const err = runError as Error;
		if (hooks.keepCutOffAnswer && err instanceof ResponseCutOffError && finalText.trim()) {
			return { finalText, rawText, stopReason, cutOff: err.message };
		}
		throw err;
	}
	return { finalText, rawText, stopReason };
}
