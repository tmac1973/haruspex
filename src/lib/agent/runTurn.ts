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
import { appendStreamDelta } from '$lib/agent/think-stream';

/** Loop options minus the streaming/lifecycle callbacks `runTurnCore` owns. */
export type TurnLoopOptions = Omit<AgentLoopOptions, 'onStreamChunk' | 'onComplete' | 'onError'>;

export interface TurnHooks {
	/** Called with the full accumulated text on each streaming delta. */
	onAssistantDelta?: (full: string) => void;
	/** Turn the raw accumulated stream into the final assistant text. */
	finalize: (raw: string) => string;
}

export async function runTurnCore(
	loop: TurnLoopOptions,
	hooks: TurnHooks
): Promise<{ finalText: string; stopReason: AgentStopReason }> {
	let streamingContent = '';
	let finalText = '';
	let stopReason: AgentStopReason = 'complete';
	let runError: Error | null = null;

	await runAgentLoop({
		...loop,
		onStreamChunk: (chunk) => {
			streamingContent = appendStreamDelta(streamingContent, chunk.delta);
			hooks.onAssistantDelta?.(streamingContent);
		},
		onComplete: (meta) => {
			finalText = hooks.finalize(streamingContent);
			stopReason = meta?.stopReason ?? 'complete';
		},
		onError: (err) => {
			runError = err;
		}
	});

	if (runError) throw runError;
	return { finalText, stopReason };
}
