/**
 * Token estimates from byte counts, for budgeting a prompt before it is sent.
 * Conservative on purpose: the fit trims a little early rather than late.
 * Re-exported by `contextBudget.ts`, which most callers import them from.
 */

import { messageText, type ChatMessage, type ToolDefinition } from '#lib/api.ts';

// Bytes per token. Real English is ~4 bytes/token; dividing by a smaller
// number over-estimates tokens, so we trim a touch early — safe.
export const TOKEN_BYTES_RATIO = 3.5;
// Per-message framing overhead (role tags, delimiters) the server adds
// that isn't in the content itself.
export const PER_MESSAGE_OVERHEAD_TOKENS = 4;

const encoder = new TextEncoder();

export function byteLength(s: string): number {
	return encoder.encode(s).length;
}

/** Conservative token estimate for a string. */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(byteLength(text) / TOKEN_BYTES_RATIO);
}

export function messageTokens(m: ChatMessage): number {
	let t = estimateTokens(messageText(m.content)) + PER_MESSAGE_OVERHEAD_TOKENS;
	if (m.tool_calls) t += estimateTokens(JSON.stringify(m.tool_calls));
	return t;
}

/** Conservative token estimate for a whole request (messages + tool schemas). */
export function estimateMessagesTokens(messages: ChatMessage[], tools?: ToolDefinition[]): number {
	let total = 0;
	for (const m of messages) total += messageTokens(m);
	if (tools && tools.length) total += estimateTokens(JSON.stringify(tools));
	return total;
}
