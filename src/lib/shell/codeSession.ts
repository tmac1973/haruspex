/**
 * Serialization for persisted Code-mode shell threads.
 *
 * The shell tab is otherwise session-scoped on purpose — a PTY dies with the
 * app, so restoring a chat without its shell would mislead. Code mode earns an
 * exception: a coding session's value is the conversation (what was decided,
 * what was tried, what failed), and that outlives the PTY. Losing it to a
 * power cut is a real cost, which is also why the write happens per turn
 * rather than on shutdown — a shutdown hook never runs when the power goes.
 *
 * Kept apart from `stores/shell.svelte.ts` so the encode/decode contract is
 * unit-testable without a Svelte runtime or a live database.
 */

import type { ChatMessage } from '$lib/api';
import type { SearchStep, AgentStopReason } from '$lib/agent/loop';
import type { MessageStats } from '$lib/stores/chat.svelte';

/**
 * Bumped when the payload shape changes incompatibly. A row written by a
 * different version is dropped rather than migrated: the cost of losing one
 * restorable thread is a re-explained coding session, while the cost of
 * mis-decoding one is a corrupted thread silently fed back to the model.
 */
export const CODE_SESSION_VERSION = 1;

export interface CodeSessionSnapshot {
	version: number;
	savedAt: number;
	messages: ChatMessage[];
	/** Index-keyed sidecars, exactly as the live session holds them. */
	messageSteps: Record<number, SearchStep[]>;
	messageStats: Record<number, MessageStats>;
	messageStops: Record<number, AgentStopReason>;
	messageHistorySent: Record<number, string[]>;
}

export type CodeSessionState = Omit<CodeSessionSnapshot, 'version' | 'savedAt'>;

/** Encode a live session's thread for storage. */
export function encodeCodeSession(state: CodeSessionState): string {
	const snapshot: CodeSessionSnapshot = {
		version: CODE_SESSION_VERSION,
		savedAt: Date.now(),
		...state
	};
	return JSON.stringify(snapshot);
}

/**
 * Decode a stored thread, or null when it is unusable — absent, corrupt,
 * written by another payload version, or carrying no messages. Returning null
 * for an empty thread matters: an empty restore would still raise the
 * "restored your session" notice while putting nothing back.
 */
export function decodeCodeSession(json: string | null): CodeSessionState | null {
	if (!json) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const snap = parsed as Partial<CodeSessionSnapshot>;
	if (snap.version !== CODE_SESSION_VERSION) return null;
	if (!Array.isArray(snap.messages) || snap.messages.length === 0) return null;
	return {
		messages: snap.messages,
		messageSteps: snap.messageSteps ?? {},
		messageStats: snap.messageStats ?? {},
		messageStops: snap.messageStops ?? {},
		messageHistorySent: snap.messageHistorySent ?? {}
	};
}

/**
 * Turns in a thread, for the restore notice. Counts user messages rather than
 * array length: the array also holds the assistant prose plus every
 * tool_calls/tool pair, so its length reads as a wildly inflated "12 turns"
 * for what the user experienced as three questions.
 */
export function countTurns(messages: ChatMessage[]): number {
	return messages.filter((m) => m.role === 'user').length;
}
