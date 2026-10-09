/**
 * Where "Fork from here" cuts a Code session's thread.
 *
 * Forking an answer keeps everything up to and including it. Forking one of
 * the user's messages keeps everything before it, and hands the message back
 * to the new session's input box to be edited and sent again.
 */
import { messageText, type ChatMessage, type MessageContentPart } from '#lib/api.ts';
import { typedText } from '#lib/skills/content.ts';

/** What the new session's input box starts with. */
export interface Prefill {
	text: string;
	/** Data URLs of images the forked message carried. */
	images: string[];
}

export interface ForkPoint {
	/** `code_session_fork`'s `at`: the new session keeps messages `[0, at)`. */
	at: number;
	prefill: Prefill | null;
}

/** The fork point for the message at `index`, or null when it can't be forked from. */
export function forkPoint(messages: ChatMessage[], index: number): ForkPoint | null {
	const msg = messages[index];
	if (!msg) return null;
	if (msg.role === 'assistant' && !msg.tool_calls?.length) return { at: index + 1, prefill: null };
	if (msg.role !== 'user') return null;
	return {
		at: index,
		prefill: {
			// A skill run travels expanded; give back what was typed.
			text: typedText(messageText(msg.content)),
			images:
				typeof msg.content === 'string'
					? []
					: (msg.content as MessageContentPart[]).flatMap((p) =>
							p.type === 'image_url' ? [p.image_url.url] : []
						)
		}
	};
}
