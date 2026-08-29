/**
 * Chat tab → Shell tab handoff.
 *
 * A chat answer that ends in "run this command" is a dead end on the Chat
 * tab: the rendered ```bash cards have Paste/Run buttons, but they're inert
 * without a terminal to send them to. "Open in shell" carries the thread over
 * to a fresh shell session so the conversation continues where the commands
 * can actually run.
 *
 * This module holds the pure reshaping half (no store imports, so it's
 * testable on its own); `fromChat.ts` does the session orchestration.
 *
 * Three things have to happen to a chat thread before a ShellSession can
 * adopt it:
 *
 *  - Tool traffic is dropped. The Chat tab's tools (run_python, web_search)
 *    don't exist in the shell toolset, and their payloads are most of the
 *    thread's token weight. The sidebar wouldn't render them either — it
 *    only draws tool work as SearchStep rows, and those are keyed by message
 *    index in state we deliberately don't carry over.
 *  - The thread is capped. Chat conversations persist across app restarts and
 *    get long; `ShellSession.trimThreadIfNeeded` only fires *after* a turn,
 *    so an unbounded import would mount every bubble at once.
 *  - A provenance note goes in front. Without it the shell prompt's framing
 *    ("commands run in the user's real terminal", "recent shell activity is
 *    what actually ran") invites the model to read the imported discussion as
 *    work already done in this PTY.
 */

import type { ChatMessage } from '$lib/api';

/** How many prose bubbles (user + assistant answers) the handoff carries. */
export const HANDOFF_KEEP_PROSE = 14;

/** Longest conversation title we'll use as a shell tab label. */
const MAX_TAB_NAME = 18;

/**
 * Prose only: the user's turns and the assistant's actual answers. Assistant
 * messages carrying `tool_calls` have empty content (the text arrives in a
 * later message), and `tool` results are raw payloads — both are noise here.
 * Chat's own `system` messages are rebuilt per turn on the shell side, so
 * they're dropped too.
 */
function isProse(m: ChatMessage): boolean {
	if (m.role === 'user') return true;
	return m.role === 'assistant' && !m.tool_calls;
}

/**
 * The system message that opens an imported thread. Visible in the sidebar
 * (ChatSidebar renders `system` entries as a thread note) so the user sees
 * the same framing the model does.
 */
export function buildHandoffNote(trimmed: boolean): ChatMessage {
	const trimNote = trimmed
		? ' Older messages from that conversation were left behind to keep this thread small.'
		: '';
	return {
		role: 'system',
		content:
			'[The conversation above was moved here from the Chat tab. The terminal ' +
			'beside it is a brand-new session: nothing discussed above has been run in ' +
			'it, and its working directory and environment are unrelated to that ' +
			'discussion. Treat those messages as background on what the user wants, not ' +
			`as a record of work already done here.${trimNote}]`
	};
}

/**
 * Reshape a chat conversation's messages into the starting thread for a shell
 * session. Returns `[]` for a conversation with nothing worth carrying, so the
 * caller can open a plain shell instead of one led by a note about nothing.
 */
export function prepareChatHandoff(
	messages: ChatMessage[],
	keepProse: number = HANDOFF_KEEP_PROSE
): ChatMessage[] {
	const prose = messages.filter(isProse);
	if (prose.length === 0) return [];
	const kept = keepProse > 0 ? prose.slice(-keepProse) : [];
	if (kept.length === 0) return [];
	return [buildHandoffNote(kept.length < prose.length), ...kept];
}

/**
 * Label the shell tab after the conversation it came from, so a user with
 * several shells open can tell which is which. Falls back to null (the
 * registry's own "Shell N") for an untitled or blank conversation.
 */
export function shellNameForConversation(title: string | undefined): string | null {
	const trimmed = (title ?? '').trim();
	if (!trimmed) return null;
	return trimmed.length > MAX_TAB_NAME ? `${trimmed.slice(0, MAX_TAB_NAME - 1)}…` : trimmed;
}
