/**
 * Rebuild a session from its events. Pure, and the only way a client away
 * from the desktop holds a session (phase 4's web client), so a test can
 * prove the events and the store never disagree.
 *
 * A `seq` gap, or an event before any snapshot, is never guessed across: the
 * mirror says `resync` and keeps what it had until a snapshot arrives.
 */
import type { ChatEvent, ChatState, SessionEvent, SessionState } from './types.ts';

export interface Mirror {
	/** Null before the first snapshot, and after `closed`. */
	state: SessionState | null;
	/** The last event applied. */
	seq: number;
	/** Missed something: ask for a snapshot. */
	resync: boolean;
	closed: boolean;
}

export const emptyMirror = (): Mirror => ({ state: null, seq: 0, resync: false, closed: false });

export function reduce(m: Mirror, e: SessionEvent): Mirror {
	if (e.type === 'snapshot') return { state: e.state, seq: e.seq, resync: false, closed: false };
	if (e.type === 'closed') return { state: null, seq: e.seq, resync: false, closed: true };
	if (!m.state || e.seq !== m.seq + 1) return { ...m, resync: true };
	const s = m.state;
	const next = { ...m, seq: e.seq };
	switch (e.type) {
		case 'status':
			return { ...next, state: { ...s, status: e.status, busy: e.busy } };
		case 'live':
			return {
				...next,
				state: { ...s, streamingContent: e.streamingContent, roundText: e.roundText }
			};
		case 'steps':
			return { ...next, state: { ...s, searchSteps: e.searchSteps } };
		case 'meta':
			return { ...next, state: { ...s, ...e.meta } };
	}
}

/** Rebuild a chat from its events, as `reduce` does for Code sessions. */
export interface ChatMirror {
	state: ChatState | null;
	seq: number;
	resync: boolean;
}

export const emptyChatMirror = (): ChatMirror => ({ state: null, seq: 0, resync: false });

export function reduceChat(m: ChatMirror, e: ChatEvent): ChatMirror {
	if (e.type === 'chat-snapshot') return { state: e.state, seq: e.seq, resync: false };
	if (!m.state || e.seq !== m.seq + 1) return { ...m, resync: true };
	return { state: { ...m.state, ...e.patch }, seq: e.seq, resync: false };
}
