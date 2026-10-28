/**
 * Delivering the caller's queued steering messages: at the iteration
 * boundary, or in place of finishing when the model would otherwise end the
 * turn with steering still queued.
 */

import type { ChatCompletionResponse, ChatMessage } from '#lib/api.ts';
import { stripThinkBlocks } from '#lib/markdown.ts';
import { logDebug } from '#lib/debugLog.ts';
import {
	appendMessage,
	type IterationOutcome,
	type LoopContext,
	type LoopState
} from '#lib/agent/loop/context.ts';
import { hasNonThinkingContent } from '#lib/agent/loop/heuristics.ts';

/** A message the user typed while the turn ran, with the images attached to it. */
export interface SteeringMessage {
	text: string;
	/** Data URLs. */
	images?: string[];
}

/** Drain a steering queue, dropping empty entries (the loop never sends them). */
export function queuedSteering(take: () => SteeringMessage[]): SteeringMessage[] {
	return take().filter((m) => m.text.trim() !== '' || (m.images?.length ?? 0) > 0);
}

/** Drain the caller's steering queue, dropping empty entries. */
function takeQueuedSteering(ctx: LoopContext): SteeringMessage[] {
	const take = ctx.options.takeSteering;
	return take ? queuedSteering(take) : [];
}

/** A steering message as the `user` message the model reads, images after the text. */
function steeringMessage({ text, images = [] }: SteeringMessage): ChatMessage {
	if (images.length === 0) return { role: 'user', content: text };
	return {
		role: 'user',
		content: [
			...(text.trim() ? [{ type: 'text' as const, text }] : []),
			...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
		]
	};
}

/** Append steering as `user` messages and tell the caller it went. */
function appendSteering(ctx: LoopContext, steers: SteeringMessage[], iteration: number): void {
	for (const m of steers) appendMessage(ctx, steeringMessage(m));
	logDebug('agent', `iteration ${iteration} steering delivered`, {
		count: steers.length,
		images: steers.reduce((n, m) => n + (m.images?.length ?? 0), 0)
	});
	ctx.options.onSteering?.(steers);
}

/** Deliver whatever steering is queued, at the iteration boundary. */
export function deliverSteering(ctx: LoopContext, iteration: number): void {
	const steers = takeQueuedSteering(ctx);
	if (steers.length > 0) appendSteering(ctx, steers, iteration);
}

/**
 * Steering must never be held past the turn. When some is queued at the point
 * the model would finish, show the
 * answer it gave (through the stream callback, without a finish reason),
 * echo it into the thread, and append the queued messages so the next iteration
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
		appendMessage(ctx, { role: 'assistant', content: stripThinkBlocks(content).trimStart() });
	}
	appendSteering(ctx, pending, iteration);
	state.steeringContinue = true;
	return 'continue';
}
