/**
 * The Code tab sidebar's view of the saved sessions: grouped by folder, and
 * how much of a long thread the transcript renders.
 */
import type { ChatMessage } from '#lib/api.ts';
import type { CodeSessionSummary } from '#lib/code/db.ts';

export interface SessionGroup {
	root: string;
	/** The folder's own name; the full path goes in a tooltip. */
	name: string;
	/** Newest first. */
	sessions: CodeSessionSummary[];
}

/** The last component of a path: `/home/me/blog/` → `blog`. */
export function folderName(root: string): string {
	return root.split(/[/\\]/).filter(Boolean).pop() ?? root;
}

/** Sessions grouped by folder. Folders with the newest session go first. */
export function groupByRoot(list: CodeSessionSummary[]): SessionGroup[] {
	const sorted = [...list].sort((a, b) => b.updated_at - a.updated_at);
	const groups = new Map<string, SessionGroup>();
	for (const s of sorted) {
		let g = groups.get(s.root);
		if (!g) {
			g = { root: s.root, name: folderName(s.root), sessions: [] };
			groups.set(s.root, g);
		}
		g.sessions.push(s);
	}
	return [...groups.values()];
}

/** Turns the transcript renders at first, and adds per "Show earlier". */
export const TURNS_PER_PAGE = 20;

/**
 * Where to start rendering so the last `turns` turns show. A turn starts at a
 * user message; the whole thread is saved, and rendering every message of a
 * long session makes switching to it slow.
 */
export function windowStart(messages: ChatMessage[], turns: number): number {
	let seen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user' && ++seen === turns) return i;
	}
	return 0;
}

/** User turns before `start`, for the "Show earlier" button. */
export function turnsBefore(messages: ChatMessage[], start: number): number {
	let n = 0;
	for (let i = 0; i < start; i++) if (messages[i].role === 'user') n++;
	return n;
}
