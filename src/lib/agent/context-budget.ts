/**
 * Deterministic pre-send context guard.
 *
 * The model server hard-rejects any request whose prompt exceeds its
 * context window (`exceed_context_size_error`). The reactive mechanisms
 * elsewhere — chat's `compactIfNeeded` and the in-loop tool trim — both
 * key off the *previous* response's token count, so neither can stop a
 * single oversized request from 400ing.
 *
 * `fitMessagesToBudget` closes that gap: it runs immediately before each
 * model call and mechanically reduces the messages array until it fits a
 * conservative byte-based estimate of the budget. It never makes a
 * network call, so it cannot itself fail — it is the hard backstop under
 * the (optional, quality-preserving) LLM summarization layer.
 *
 * Token counting is a byte heuristic (same `chars/4` rule of thumb used
 * by shell/truncate.ts) rather than a real tokenizer: no `/tokenize`
 * round-trip, and it works identically for remote backends. We divide by
 * a slightly low ratio so we *over*-estimate — the safe direction for a
 * guard that must keep us under a hard wall.
 */

import { messageText, type ChatMessage, type ToolDefinition } from '$lib/api';
import { truncateCapturedOutput } from '$lib/shell/truncate';

// Bytes per token. Real English is ~4 bytes/token; dividing by a smaller
// number over-estimates tokens, so we trim a touch early — safe.
const TOKEN_BYTES_RATIO = 3.5;
// Per-message framing overhead (role tags, delimiters) the server adds
// that isn't in the content itself.
const PER_MESSAGE_OVERHEAD_TOKENS = 4;
// Always keep this many of the most recent tool messages verbatim — the
// model needs the freshest results to answer. (Mirrors the constant the
// agent loop used before this module owned trimming.)
export const PRESERVE_RECENT_TOOL_MESSAGES = 3;
// When dropping old turns, always keep the last this-many user/assistant
// pairs so recent conversation stays intact.
const PROTECTED_TURNS = 4;
// A single message bigger than this fraction of the budget is a
// head/tail-truncation candidate (catches a giant pasted log / dmesg).
const OVERSIZED_MESSAGE_FRACTION = 0.25;

const encoder = new TextEncoder();

function byteLength(s: string): number {
	return encoder.encode(s).length;
}

/** Conservative token estimate for a string. */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(byteLength(text) / TOKEN_BYTES_RATIO);
}

function messageTokens(m: ChatMessage): number {
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

/**
 * Replace older tool-message content with a short stub. Returns true if
 * any messages were trimmed. Moved here from the agent loop so both the
 * loop and the pre-send guard share one implementation.
 */
export function trimOldToolMessages(messages: ChatMessage[]): boolean {
	const toolIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'tool') toolIndices.push(i);
	}
	if (toolIndices.length <= PRESERVE_RECENT_TOOL_MESSAGES) return false;
	const trimUpTo = toolIndices.length - PRESERVE_RECENT_TOOL_MESSAGES;
	let trimmed = false;
	for (let k = 0; k < trimUpTo; k++) {
		const idx = toolIndices[k];
		const msg = messages[idx];
		const text = messageText(msg.content);
		if (text.startsWith('[Trimmed:')) continue;
		const stub = `[Trimmed: ${text.length} chars dropped to free context. Earlier tool result is no longer in scope — refer to more recent results or call the tool again if needed.]`;
		messages[idx] = { ...msg, content: stub };
		trimmed = true;
	}
	return trimmed;
}

export interface ContextManagedInfo {
	/** Older tool results were stubbed. */
	trimmedTools: boolean;
	/** Number of oversized messages head/tail-truncated. */
	truncatedMessages: number;
	/** Number of old user/assistant messages dropped. */
	droppedTurns: number;
	beforeEst: number;
	afterEst: number;
}

/** One-line, human-readable summary of a context-guard action, for the UI. */
export function describeContextManaged(info: ContextManagedInfo): string {
	const parts: string[] = [];
	if (info.droppedTurns > 0) parts.push(`dropped ${info.droppedTurns} older message(s)`);
	if (info.truncatedMessages > 0) {
		parts.push(`truncated ${info.truncatedMessages} large message(s)`);
	}
	if (info.trimmedTools) parts.push('trimmed earlier tool results');
	const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
	return `Compacted earlier history to fit the model's context${detail}.`;
}

// Multiplier mapping our raw byte estimate to real tokenizer counts.
// Density varies wildly — English prose is ~1.0, but code, JSON, logs,
// file paths, and the chat template's rendering of the tool schemas all
// tokenize far denser than bytes/3.5 assumes. Rather than guess a fixed
// ratio (which 400'd on dense shell content), we LEARN it from the actual
// `prompt_tokens` the server reports and bias upward so we stay safe.
const DEFAULT_CALIBRATION = 1.5;
const MIN_CALIBRATION = 1.0;
const MAX_CALIBRATION = 4.0;
let tokenCalibration = DEFAULT_CALIBRATION;

export function getTokenCalibration(): number {
	return tokenCalibration;
}

/** Reset to the default calibration (used by tests). */
export function resetTokenCalibration(): void {
	tokenCalibration = DEFAULT_CALIBRATION;
}

/**
 * Update the estimate→actual calibration from an observed request, where
 * `rawEstimate` is `estimateMessagesTokens` of what we sent and
 * `actualPromptTokens` is the server-reported prompt size. Increases are
 * adopted immediately (stay under the wall); decreases ease in gradually
 * so one light request doesn't make us over-optimistic. Never drops below
 * 1.0, so the effective budget is always <= the real budget.
 */
export function recordTokenCalibration(rawEstimate: number, actualPromptTokens: number): void {
	if (rawEstimate <= 0 || actualPromptTokens <= 0) return;
	const ratio = Math.min(
		MAX_CALIBRATION,
		Math.max(MIN_CALIBRATION, actualPromptTokens / rawEstimate)
	);
	tokenCalibration = ratio > tokenCalibration ? ratio : tokenCalibration * 0.6 + ratio * 0.4;
}

/**
 * Parse a llama-server context-overflow error body for the exact token
 * counts. Returns null if the message isn't a context-overflow error.
 * Used to calibrate precisely and retry after a 400 slips through.
 */
export function parseContextOverflow(
	message: string
): { promptTokens: number; contextSize: number } | null {
	if (!/exceed_context_size|exceeds the available context/.test(message)) return null;
	const prompt =
		/"n_prompt_tokens"\s*:\s*(\d+)/.exec(message) ?? /request \((\d+)\s+tokens\)/.exec(message);
	const ctx =
		/"n_ctx"\s*:\s*(\d+)/.exec(message) ?? /context size \((\d+)\s+tokens\)/.exec(message);
	if (!prompt) return null;
	return {
		promptTokens: Number(prompt[1]),
		contextSize: ctx ? Number(ctx[1]) : 0
	};
}

export interface FitOptions {
	/** Tokens to reserve for the model's output so the prompt leaves room to generate. */
	reserveOutput: number;
	/** Tool schemas that will be sent alongside (counted toward the estimate). */
	tools?: ToolDefinition[];
}

/**
 * Reduce `messages` in place until a conservative estimate fits the
 * *calibrated* budget `(contextSize - reserveOutput) / tokenCalibration`.
 * Returns a summary of what was done, or `null` if it already fit (no
 * mutation). The post-condition `estimateMessagesTokens(messages) <=
 * effectiveBudget` always holds on return.
 *
 * Strategy, cheapest/least-lossy first, re-checking after each step:
 *   1. Stub older tool results.
 *   2. Head/tail-truncate any single oversized message.
 *   3. Drop oldest user/assistant turns (keep system + recent pairs).
 *   4. Force-fit: halve the largest remaining message repeatedly.
 */
export function fitMessagesToBudget(
	messages: ChatMessage[],
	contextSize: number,
	opts: FitOptions
): ContextManagedInfo | null {
	if (contextSize <= 0) return null;
	const budget = Math.max(1, contextSize - opts.reserveOutput);
	// Our raw byte estimate under-counts dense content, so target a budget
	// scaled down by the learned calibration factor.
	const effectiveBudget = Math.max(1, Math.floor(budget / tokenCalibration));
	const fits = () => estimateMessagesTokens(messages, opts.tools) <= effectiveBudget;

	const beforeEst = estimateMessagesTokens(messages, opts.tools);
	if (beforeEst <= effectiveBudget) return null;

	// Step 1: stub older tool messages.
	const trimmedTools = trimOldToolMessages(messages);

	// Step 2: head/tail-truncate oversized single messages, largest first.
	let truncatedMessages = 0;
	if (!fits()) {
		const oversizedTokenCap = Math.max(1, Math.floor(effectiveBudget * OVERSIZED_MESSAGE_FRACTION));
		const candidates = messages
			.map((m, i) => ({ i, m, tokens: messageTokens(m) }))
			.filter((c) => typeof c.m.content === 'string' && c.tokens > oversizedTokenCap)
			.sort((a, b) => b.tokens - a.tokens);
		const maxBytes = Math.floor(oversizedTokenCap * TOKEN_BYTES_RATIO);
		for (const c of candidates) {
			if (fits()) break;
			const result = truncateCapturedOutput(c.m.content as string, maxBytes);
			if (result.truncated) {
				messages[c.i] = { ...c.m, content: result.text };
				truncatedMessages++;
			}
		}
	}

	// Step 3: drop oldest user/assistant turns, keep system + recent pairs.
	let droppedTurns = 0;
	if (!fits()) {
		droppedTurns = dropOldestTurns(messages, effectiveBudget, opts.tools);
	}

	// Step 4: pathological fallback — guarantee the fit.
	if (!fits()) {
		forceFit(messages, effectiveBudget, opts.tools);
	}

	return {
		trimmedTools,
		truncatedMessages,
		droppedTurns,
		beforeEst,
		afterEst: estimateMessagesTokens(messages, opts.tools)
	};
}

/**
 * Drop the oldest non-system messages (preserving all leading system
 * messages and the last PROTECTED_TURNS pairs) until the estimate fits,
 * noting the drop in the leading system message (never adding a new one).
 * Orphaned tool results left behind are sanitized away. Returns the count
 * dropped.
 */
function dropOldestTurns(
	messages: ChatMessage[],
	budget: number,
	tools?: ToolDefinition[]
): number {
	const protectedCount = PROTECTED_TURNS * 2;
	const nonSystemIdx: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role !== 'system') nonSystemIdx.push(i);
	}
	if (nonSystemIdx.length <= protectedCount) return 0;

	const droppable = nonSystemIdx.slice(0, nonSystemIdx.length - protectedCount);
	const toRemove = new Set<number>();
	let dropped = 0;
	for (const idx of droppable) {
		if (
			estimateMessagesTokens(
				messages.filter((_, i) => !toRemove.has(i)),
				tools
			) <= budget
		) {
			break;
		}
		toRemove.add(idx);
		dropped++;
	}
	if (dropped === 0) return 0;

	const kept = messages.filter((_, i) => !toRemove.has(i));
	sanitizeOrphanToolResults(kept);

	// Note the drop in the prompt. Crucially we must NOT introduce a second
	// system message — some chat templates (e.g. Qwen) reject any system
	// message that isn't the very first. So fold the note into the existing
	// leading system message; only if there is none do we fall back to a
	// standalone user message.
	const note = `[Older messages dropped to fit context: ${dropped} message(s) removed.]`;
	if (kept.length > 0 && kept[0].role === 'system') {
		kept[0] = { ...kept[0], content: `${messageText(kept[0].content)}\n\n${note}` };
	} else {
		kept.unshift({ role: 'user', content: note });
	}

	messages.length = 0;
	messages.push(...kept);
	return dropped;
}

/**
 * Remove tool messages whose matching assistant tool_call was dropped —
 * an orphaned tool result with no preceding call can be rejected by
 * strict servers.
 */
function sanitizeOrphanToolResults(messages: ChatMessage[]): void {
	const validIds = new Set<string>();
	for (const m of messages) {
		if (m.role === 'assistant' && m.tool_calls) {
			for (const tc of m.tool_calls) validIds.add(tc.id);
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === 'tool' && m.tool_call_id && !validIds.has(m.tool_call_id)) {
			messages.splice(i, 1);
		}
	}
}

/**
 * Last-resort guaranteed fit: repeatedly halve the largest string
 * message (replacing with a placeholder once it gets tiny) until the
 * estimate is under budget. Converges geometrically.
 */
function forceFit(messages: ChatMessage[], budget: number, tools?: ToolDefinition[]): void {
	for (let guard = 0; guard < 100; guard++) {
		if (estimateMessagesTokens(messages, tools) <= budget) return;
		let best = -1;
		let bestTokens = 0;
		for (let i = 0; i < messages.length; i++) {
			if (typeof messages[i].content !== 'string') continue;
			const t = messageTokens(messages[i]);
			if (t > bestTokens) {
				bestTokens = t;
				best = i;
			}
		}
		if (best < 0) return; // nothing left to truncate
		const m = messages[best];
		const text = m.content as string;
		const half = Math.floor(byteLength(text) / 2);
		if (half < 32) {
			messages[best] = { ...m, content: '[Removed to fit context.]' };
			continue;
		}
		const result = truncateCapturedOutput(text, half);
		messages[best] = {
			...m,
			content: result.truncated ? result.text : '[Removed to fit context.]'
		};
	}
}
