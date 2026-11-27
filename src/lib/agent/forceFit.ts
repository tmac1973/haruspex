/**
 * The context fit's last resort (`fitMessagesToBudget`): cut string messages
 * until the estimate is under budget, whatever that costs.
 */

import type { ChatMessage, ToolDefinition } from '#lib/api.ts';
import { keepResult, recallHint, type RecallArchive } from '#lib/agent/recallArchive.ts';
import { describeToolCall } from '#lib/agent/toolRounds.ts';
import { byteLength, estimateMessagesTokens, messageTokens } from '#lib/agent/tokenEstimate.ts';
import { truncateCapturedOutput } from '#lib/shell/truncate.ts';

const REMOVED = '[Removed to fit context.]';

export interface ForceFitOptions {
	tools?: ToolDefinition[];
	/**
	 * Where a cut tool result's whole text goes, so the marker can carry its
	 * `recall_result` id. Without it the text was gone for the rest of the
	 * turn: in a live forced fit, two results became a bare marker (#1022).
	 */
	archive?: RecallArchive;
	/** A message over this many tokens is halved rather than removed. */
	bigEnough: number;
}

/**
 * Cut, in this order:
 *
 * 1. Any non-system message bigger than `bigEnough` (a quarter of the
 *    budget), halved, the biggest first. A giant paste is worth less than the
 *    instructions.
 * 2. Every other message but the latest user message, replaced whole with a
 *    marker, the biggest first. Halving these took several passes each, and
 *    older tool results are worth less than the instructions too: ranked below
 *    the system prompt, they kept their halves while it was cut (#1022).
 * 3. The system prompt, halved.
 * 4. The latest user message, halved: the question is worth more than the
 *    end of the instructions.
 *
 * Returns whether the system prompt was cut.
 */
export function forceFit(messages: ChatMessage[], budget: number, opts: ForceFitOptions): boolean {
	const question = messages.findLastIndex((m) => m.role === 'user');
	let cutSystem = false;
	for (let guard = 0; guard < 100; guard++) {
		if (estimateMessagesTokens(messages, opts.tools) <= budget) break;
		const pick = nextToCut(messages, opts.bigEnough, question);
		if (!pick) break; // nothing left to cut
		const { idx, tier } = pick;
		const m = messages[idx];
		if (m.role === 'system') cutSystem = true;
		const text = m.content as string;
		const id = keepResult(opts.archive, messages, idx, text, describeToolCall(messages, idx));
		const half = Math.floor(byteLength(text) / 2);
		const result =
			tier === CutTier.Whole || half < 32
				? null
				: truncateCapturedOutput(text, half, id ? recallHint(id) : undefined);
		messages[idx] = { ...m, content: result?.truncated ? result.text : removedMarker(id) };
	}
	return cutSystem;
}

function removedMarker(id: string | null): string {
	return id ? `[Removed to fit context. ${recallHint(id)}]` : REMOVED;
}

/** `forceFit`'s order: the higher tier is cut first. */
const CutTier = { Question: 0, System: 1, Whole: 2, Big: 3 } as const;
type CutTier = (typeof CutTier)[keyof typeof CutTier];

/** The message `forceFit` cuts next: the highest tier, then the biggest. */
function nextToCut(
	messages: ChatMessage[],
	bigEnough: number,
	question: number
): { idx: number; tier: CutTier } | null {
	let best: { idx: number; tier: CutTier } | null = null;
	let bestRank = -1;
	for (let i = 0; i < messages.length; i++) {
		const content = messages[i].content;
		if (typeof content !== 'string' || content.startsWith(REMOVED.slice(0, -1))) continue;
		const t = messageTokens(messages[i]);
		const tier: CutTier =
			messages[i].role === 'system'
				? CutTier.System
				: t > bigEnough
					? CutTier.Big
					: i === question
						? CutTier.Question
						: CutTier.Whole;
		if (tier * 1e9 + t > bestRank) {
			bestRank = tier * 1e9 + t;
			best = { idx: i, tier };
		}
	}
	return best;
}
