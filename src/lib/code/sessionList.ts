/**
 * The Code tab sidebar's view of the saved sessions: what each is called, a
 * flat list that groups a folder only when it has several, and how much of a
 * long thread the transcript renders.
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

/**
 * True while a session has no title of its own. A title that starts with `/`
 * counts as none: older sessions were named after their first message even
 * when it was a slash command.
 */
export function isUnsetTitle(title: string): boolean {
	const t = title.trim();
	return t === '' || t.startsWith('/');
}

/** What the sidebar and tab call a session: its title, or `blog · new session`. */
export function sessionLabel(s: { title: string; root: string }): string {
	return isUnsetTitle(s.title) ? `${folderName(s.root)} · new session` : s.title.trim();
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

/** A row of the sidebar: one session, or a folder that has several. */
export type SidebarEntry =
	| { kind: 'session'; session: CodeSessionSummary }
	| ({ kind: 'folder' } & SessionGroup);

/** Sessions a folder needs before they are grouped under it. */
export const GROUP_AT = 2;

/**
 * The sidebar, newest first: a session on its own row, unless its folder has
 * `GROUP_AT` or more, which then sit under one folder row placed by their
 * newest.
 */
export function sidebarEntries(list: CodeSessionSummary[]): SidebarEntry[] {
	return groupByRoot(list).map((g) =>
		g.sessions.length >= GROUP_AT
			? { kind: 'folder', ...g }
			: { kind: 'session', session: g.sessions[0] }
	);
}

/** When a session was last active, short: `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function lastActive(at: number, now = Date.now()): string {
	const s = Math.max(0, Math.floor((now - at) / 1000));
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
	return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
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
