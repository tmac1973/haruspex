/**
 * Delivering the caller's queued steering messages: at the iteration
 * boundary, or in place of finishing when the model would otherwise end the
 * turn with steering still queued.
 */

import type { ChatCompletionResponse } from '#lib/api.ts';
import { stripThinkBlocks } from '#lib/markdown.ts';
import { logDebug } from '#lib/debug-log.ts';
import type { IterationOutcome, LoopContext, LoopState } from './context';
import { hasNonThinkingContent } from './heuristics';

/** Drain the caller's steering queue, dropping blank entries. */
function takeQueuedSteering(ctx: LoopContext): string[] {
	return (ctx.options.takeSteering?.() ?? []).filter((t) => t.trim() !== '');
}

/** Append steering texts as `user` messages and tell the caller they went. */
function appendSteering(ctx: LoopContext, texts: string[], iteration: number): void {
	for (const content of texts) ctx.messages.push({ role: 'user', content });
	logDebug('agent', `iteration ${iteration} steering delivered`, { count: texts.length });
	ctx.options.onSteering?.(texts);
}

/** Deliver whatever steering is queued, at the iteration boundary. */
export function deliverSteering(ctx: LoopContext, iteration: number): void {
	const texts = takeQueuedSteering(ctx);
	if (texts.length > 0) appendSteering(ctx, texts, iteration);
}

/**
 * Steering must never be held past the turn. When some is queued at the point
 * the model would finish, show the
 * answer it gave (through the stream callback, without a finish reason),
 * echo it into the thread, and append the queued texts so the next iteration
 * answers them. Null when nothing is queued.
 */
export function continueForSteering(
	ctx: LoopContext,
	state: LoopState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	// With nothing queued the normal completion paths own the answer.
	const pending = takeQueuedSteering(ctx);
	if (pending.length === 0) return null;
	const content = response.content ?? '';
	logDebug('agent', `iteration ${iteration} branch=steering-continue`, {
		count: pending.length
	});
	if (hasNonThinkingContent(content)) {
		ctx.options.onStreamChunk({ delta: { content }, finish_reason: null });
		// Re-sent to the model, so without the reasoning (see pushNudge).
		ctx.messages.push({ role: 'assistant', content: stripThinkBlocks(content).trimStart() });
	}
	appendSteering(ctx, pending, iteration);
	state.steeringContinue = true;
	return 'continue';
}
