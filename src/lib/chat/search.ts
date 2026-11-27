/**
 * Finding chats in the conversation list: by title as you type, and by what
 * was said in them, through each computer's own full-text index
 * (`db_search_conversations`, or `chats.search` on another computer).
 */
import { dbQuery } from '#lib/stores/dbCall.ts';
import type { PeerView } from '#lib/peers/store.svelte.ts';

/** Whether `title` contains every word of `filter`, ignoring case. */
export function titleMatches(title: string, filter: string): boolean {
	const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
	const t = title.toLowerCase();
	return words.every((w) => t.includes(w));
}

/** This computer's chats whose messages match `query`. */
export async function searchLocalChats(query: string): Promise<string[]> {
	if (!query.trim()) return [];
	return dbQuery<string[]>({
		cmd: 'db_search_conversations',
		category: 'chat',
		args: { query },
		onError: 'Chat search failed',
		fallback: []
	});
}

/**
 * Another computer's chats whose messages match: null when it can't say (a
 * Haruspex from before `chats.search`, or offline), so titles alone filter.
 */
export async function searchPeerChats(view: PeerView, query: string): Promise<string[] | null> {
	if (!query.trim() || !view.online) return null;
	try {
		return await view.client.op<string[]>({ type: 'chats.search', query });
	} catch {
		return null;
	}
}
