/**
 * A chat's summary message: what a compaction inserts where the messages it
 * kept whole start (`agent/compaction.ts`). Apart from the summariser so the
 * chat views (desktop and web) can recognise one without importing it.
 */
import type { ChatMessage } from '#lib/api.ts';

/** How a summary message starts. */
export const SUMMARY_PREFIX = '[Earlier conversation summary]';

function text(m: ChatMessage): string {
	if (typeof m.content === 'string') return m.content;
	return m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

/** A summary a compaction left in a chat. */
export function isSummaryMessage(m: ChatMessage): boolean {
	return m.role === 'system' && text(m).startsWith(SUMMARY_PREFIX);
}

/** A summary message's text, without its prefix. */
export function summaryText(m: ChatMessage): string {
	return text(m).slice(SUMMARY_PREFIX.length).trim();
}
