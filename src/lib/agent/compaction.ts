import { messageText, type ChatMessage } from '#lib/api.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { answerForSummary, summarizeInChunks } from '#lib/agent/summarize.ts';
import { SUMMARY_PREFIX, isSummaryMessage } from './summaryMessage';

export { SUMMARY_PREFIX, isSummaryMessage };

const COMPACTION_THRESHOLD = 0.8;
const PROTECTED_TURNS = 4;

// Scope note: this summary serves THIS conversation only. Facts worth
// carrying into future ones are agentic memory's job (see agent/memory/), so
// there is no need to hoard standing preferences here at the cost of the
// detail the current thread still needs.
const SUMMARY_PROMPT =
	'Summarize the following conversation concisely, preserving key facts, decisions, user preferences, and context needed to continue THIS conversation naturally. Be thorough but brief. Output only the summary, no preamble.';

/**
 * What of a chat the model is sent: from its latest summary on, or all of it
 * before any. A compaction inserts its summary where the kept messages
 * start rather than deleting what it summarised, so the scrollback stays
 * whole and the model's view is everything from the last summary.
 */
export function chatModelView(messages: ChatMessage[]): ChatMessage[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isSummaryMessage(messages[i])) return messages.slice(i);
	}
	return messages;
}

export function shouldCompact(promptTokens: number, contextSize: number): boolean {
	if (contextSize === 0 || promptTokens === 0) return false;
	return promptTokens / contextSize >= COMPACTION_THRESHOLD;
}

/**
 * Summarise all but the last PROTECTED_TURNS exchanges of `messages` (the
 * model's view, `chatModelView`). `removedCount` is how many of `messages`
 * the summary covers. An earlier summary (a leading
 * SUMMARY_PREFIX system message) is carried into the new one rather than
 * lost with the other non-turn messages.
 *
 * Summarised in chunks that each fit the window (`summarizeInChunks`): sent
 * as one request, a long enough chat overflowed it. Throws when the model
 * call fails; the caller carries on without a summary.
 */
export async function compactConversation(
	messages: ChatMessage[],
	signal?: AbortSignal
): Promise<{ summary: string; removedCount: number }> {
	// Split into user/assistant messages only (tool messages should already be stripped)
	const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');

	// Keep the last PROTECTED_TURNS pairs (up to PROTECTED_TURNS * 2 messages)
	const protectedCount = PROTECTED_TURNS * 2;
	if (turns.length <= protectedCount) {
		return { summary: '', removedCount: 0 };
	}

	const compactable = turns.slice(0, turns.length - protectedCount);

	const parts = compactable.map((m) => {
		const role = m.role === 'user' ? 'User' : 'Assistant';
		// Without reasoning, for a cleaner summary (see answerForSummary)
		const content = answerForSummary(messageText(m.content));
		return `${role}: ${content}`;
	});

	// Compaction always runs against the global Settings backend.
	const summary = await summarizeInChunks({
		prompt: SUMMARY_PROMPT,
		previous: earlierSummary(messages),
		parts,
		backend: null,
		contextSize: resolveBackendDescriptor().contextSize,
		signal
	});

	// Count how many messages from the original array to remove
	// We need to find the compactable messages in the original array
	const compactableSet = new Set(compactable);
	let removedCount = 0;
	for (const m of messages) {
		if (compactableSet.has(m)) removedCount++;
	}

	return { summary, removedCount };
}

/** The summary a previous compaction left at the head of `messages`, if any. */
function earlierSummary(messages: ChatMessage[]): string | null {
	for (const m of messages) {
		if (m.role !== 'system') break;
		const text = messageText(m.content);
		if (text.startsWith(SUMMARY_PREFIX)) return text.slice(SUMMARY_PREFIX.length).trim() || null;
	}
	return null;
}

/**
 * Remap a Record keyed by message INDEX after the message array has been
 * rewritten (compaction). Entries whose message survived move to the
 * message's new index; entries for summarized-away messages are dropped.
 * Matching is by object identity — compaction reuses the kept message
 * objects.
 */
export function remapIndexedRecords<T>(
	oldMessages: readonly unknown[],
	newMessages: readonly unknown[],
	records: Record<number, T>
): Record<number, T> {
	const oldIndexByMessage = new Map(oldMessages.map((m, i) => [m, i]));
	const out: Record<number, T> = {};
	newMessages.forEach((m, newIdx) => {
		const oldIdx = oldIndexByMessage.get(m);
		if (oldIdx === undefined) return; // e.g. the inserted summary message
		const value = records[oldIdx];
		if (value !== undefined) out[newIdx] = value;
	});
	return out;
}
