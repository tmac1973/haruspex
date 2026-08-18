/**
 * A remote session's conversation: where it lives, what it is called, and how
 * it is kept inside the context window.
 *
 * A guest's chat is an ordinary conversation row — the same one the local
 * sidebar lists, the same one the host can read, rename or delete. Nothing new
 * is stored and nothing new needs backing up. The only thing special about it
 * is the id, which is derived from the session rather than random, so a guest
 * who reloads (or comes back after the host restarted Haruspex) continues where
 * they left off instead of starting a stranger's conversation.
 */

import type { ChatMessage } from '$lib/api';
import { compactConversation, shouldCompact } from '$lib/agent/compaction';
import { estimateMessagesTokens, getTokenCalibration } from '$lib/agent/context-budget';
import { logDebug } from '$lib/debug-log';

/**
 * Turns kept verbatim when a session is summarised. Matches the local chat
 * path's protected window, so a guest's conversation degrades the same way the
 * host's does.
 */
const PROTECTED_MESSAGES = 8;

/** Longest guest-supplied name kept, and the fallback when there is none. */
const MAX_LABEL_LENGTH = 40;
const DEFAULT_LABEL = 'Guest';

/** Matches the local chat's own title length, so the sidebar stays uniform. */
const MAX_TITLE_LENGTH = 50;

export function conversationIdFor(sessionId: string): string {
	return `remote-${sessionId}`;
}

/**
 * Names the thread the way the local chat names its own — after the first thing
 * asked — with the guest's name in front of it.
 *
 * Naming every remote thread "Remote — Dave" made the sidebar useless the
 * moment Dave asked a second question: a column of identical rows, none of them
 * saying what they were about. The prefix keeps the origin obvious while the
 * rest does the work a title is for.
 *
 * The label is guest-supplied text: bounded, stripped of control characters,
 * and never trusted to be non-empty.
 */
export function titleFor(label: string | null | undefined, firstMessage = ''): string {
	const name =
		(label ?? '')
			// eslint-disable-next-line no-control-regex -- stripping them is the point
			.replace(/[\u0000-\u001f\u007f]/g, ' ')
			.trim()
			.slice(0, MAX_LABEL_LENGTH)
			.trim() || DEFAULT_LABEL;

	// Same rule as the local chat's own titles, so the two read alike.
	const summary = firstMessage.slice(0, MAX_TITLE_LENGTH).replace(/\n/g, ' ').trim();
	return summary ? `${name}: ${summary}` : `${name}: new chat`;
}

export interface PreparedHistory {
	messages: ChatMessage[];
	/** True when the history was rewritten and should be persisted as the new one. */
	rewritten: boolean;
}

/**
 * Fit a session's history into the context window.
 *
 * A guest who chats for an hour runs out of room exactly as a local user does,
 * so this reuses the app's summariser rather than inventing a second policy —
 * the conversation keeps its meaning instead of losing its beginning.
 *
 * The fallback matters more than the summary. Summarising is itself a model
 * call, and if it fails (model stopped, backend unreachable) the alternative to
 * trimming is a turn that dies at the context limit while the guest watches. So
 * a failed summary drops the oldest turns and carries on.
 *
 * Call this while holding the inference slot: the summary is a model call, and
 * running it outside the queue would let a guest collide with the person at the
 * keyboard — the exact thing the queue exists to prevent.
 */
export async function prepareHistory(
	history: ChatMessage[],
	contextSize: number,
	signal?: AbortSignal
): Promise<PreparedHistory> {
	if (history.length < 4) return { messages: history, rewritten: false };

	const estimated = estimateMessagesTokens(history) * getTokenCalibration();
	if (!shouldCompact(estimated, contextSize)) return { messages: history, rewritten: false };

	try {
		const { summary, removedCount } = await compactConversation(history, signal);
		if (summary && removedCount > 0) {
			return { messages: withSummary(history, summary), rewritten: true };
		}
	} catch (error) {
		logDebug('remote', `could not summarise a guest's history: ${String(error)}`);
	}

	return { messages: trimmed(history), rewritten: true };
}

function conversationTurns(history: ChatMessage[]): ChatMessage[] {
	return history.filter((m) => m.role === 'user' || m.role === 'assistant');
}

function withSummary(history: ChatMessage[], summary: string): ChatMessage[] {
	const turns = conversationTurns(history);
	return [
		{ role: 'system', content: `[Earlier conversation summary]\n${summary}` },
		...turns.slice(-PROTECTED_MESSAGES)
	];
}

function trimmed(history: ChatMessage[]): ChatMessage[] {
	return conversationTurns(history).slice(-PROTECTED_MESSAGES);
}
