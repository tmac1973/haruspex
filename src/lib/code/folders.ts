/**
 * Code sessions sharing a folder: the frontend side of
 * `code_tools/folders.rs`.
 *
 * - `createWriteGuard` is a turn's `ToolContext.codeWriteGuard`. Its first
 *   write takes the folder's writer lease (kept for the rest of the turn);
 *   another session's write is refused while it is held. `finish` records
 *   the files the turn changed, for the others, and gives the lease back.
 * - `takeFileNotices` / `formatFileNotices`: what other sessions changed in
 *   the folder since this one last looked, as the note its next turn opens
 *   with.
 *
 * Rust holds both, because a session in a detached window runs in another
 * webview.
 */
import { invoke } from '@tauri-apps/api/core';
import type { CodeWriteGuard } from '#lib/agent/tools/types.ts';
import type { FileNotice } from '#lib/ipc/gen/FileNotice.ts';
import type { FileNotices } from '#lib/ipc/gen/FileNotices.ts';
import type { WorktreeRemoval } from '#lib/ipc/gen/WorktreeRemoval.ts';
import { listCodeSessions, type CodeSessionSummary } from '#lib/code/db.ts';
import { logDebug } from '#lib/debug-log.ts';
import { errMessage } from '#lib/utils/error.ts';

/** What a write is told while another session has the folder. */
export function leaseRefusal(holder: string): string {
	const who = holder.trim() ? `(${holder.trim()})` : '(untitled)';
	return `Another session ${who} is editing this folder right now; wait for it to finish, or work in a worktree.`;
}

/** `path` as an absolute path, against `root` when it is relative. */
export function absolutePath(root: string, path: string): string {
	if (path.startsWith('/')) return path;
	const rel = path.replace(/^(\.\/)+/, '');
	return `${root.replace(/\/+$/, '')}/${rel}`;
}

export interface TurnWriteGuard extends CodeWriteGuard {
	/** Record what changed and give the folder back. Never throws. */
	finish(): Promise<void>;
}

/**
 * The guard for one turn of session `sessionId` in `root`. `title` is read
 * when it is needed, so a session named mid-turn is named to the others.
 */
export function createWriteGuard(opts: {
	sessionId: string;
	root: string;
	/** The WSL distro `root` is in: the same path in another distro is another folder. */
	wslDistro?: string | null;
	title: () => string;
}): TurnWriteGuard {
	const wslDistro = opts.wslDistro ?? null;
	let held = false;
	const files = new Set<string>();
	return {
		async acquire() {
			if (held) return null;
			try {
				const holder = await invoke<string | null>('code_lease_take', {
					folder: opts.root,
					wslDistro,
					sessionId: opts.sessionId,
					title: opts.title()
				});
				if (holder !== null && holder !== undefined) return leaseRefusal(holder);
			} catch (e) {
				// The rule protects against a race; failing to check it must not
				// stop the session from working.
				logDebug('code', 'taking the folder failed', { error: errMessage(e) });
			}
			held = true;
			return null;
		},
		changed(paths) {
			for (const p of paths) files.add(absolutePath(opts.root, p));
		},
		async finish() {
			try {
				if (files.size > 0) {
					await invoke('code_notice_record', {
						folder: opts.root,
						wslDistro,
						sessionId: opts.sessionId,
						title: opts.title(),
						files: [...files]
					});
				}
			} catch (e) {
				logDebug('code', 'recording changed files failed', { error: errMessage(e) });
			}
			files.clear();
			if (!held) return;
			held = false;
			await invoke('code_lease_release', { sessionId: opts.sessionId }).catch((e: unknown) =>
				logDebug('code', 'releasing the folder failed', { error: errMessage(e) })
			);
		}
	};
}

/** Give back a session's lease outside a turn (closing it). */
export async function releaseFolder(sessionId: string): Promise<void> {
	await invoke('code_lease_release', { sessionId }).catch(() => {});
}

/**
 * Other sessions' changes in `root` since `since` (ms), and the time to pass
 * next. Empty, and `since` unchanged, when the check fails.
 */
export async function takeFileNotices(
	sessionId: string,
	root: string,
	since: number,
	wslDistro: string | null = null
): Promise<FileNotices> {
	try {
		const res = await invoke<FileNotices | null>('code_notices_take', {
			folder: root,
			wslDistro,
			sessionId,
			since
		});
		return res ?? { notices: [], now: since };
	} catch (e) {
		logDebug('code', 'reading changed files failed', { error: errMessage(e) });
		return { notices: [], now: since };
	}
}

/** Files named per session, past which the rest are counted. */
const FILES_SHOWN = 20;

/**
 * "Since your last turn, session 'X' changed: a.ts, b.ts", one line per
 * session, paths relative to `root` when inside it. Null when nothing changed.
 */
export function formatFileNotices(notices: FileNotice[], root: string): string | null {
	const bySession = new Map<string, { title: string; files: string[] }>();
	for (const n of notices) {
		const entry = bySession.get(n.session_id) ?? { title: n.title, files: [] };
		// The newest title wins: a session may have been named since.
		entry.title = n.title || entry.title;
		for (const f of n.files) {
			const shown = relativeTo(root, f);
			if (!entry.files.includes(shown)) entry.files.push(shown);
		}
		bySession.set(n.session_id, entry);
	}
	if (bySession.size === 0) return null;
	const lines = [...bySession.values()].map(({ title, files }) => {
		const named = files.slice(0, FILES_SHOWN).join(', ');
		const more = files.length > FILES_SHOWN ? ` and ${files.length - FILES_SHOWN} more` : '';
		return `Since your last turn, session '${title || 'untitled'}' changed: ${named}${more}`;
	});
	return `${lines.join('\n')}\nRe-read those files before editing them.`;
}

function relativeTo(root: string, path: string): string {
	const base = root.replace(/\/+$/, '') + '/';
	return path.startsWith(base) ? path.slice(base.length) : path;
}

/**
 * The same folder, or one inside the other (as Rust's lease compares them).
 * Folders in different WSL distros, or one in a distro and one on the host,
 * never overlap.
 */
export function rootsOverlap(
	a: string,
	b: string,
	distros: [string | null | undefined, string | null | undefined] = [null, null]
): boolean {
	if ((distros[0] ?? null) !== (distros[1] ?? null)) return false;
	const norm = (p: string) => p.replace(/\/+$/, '') + '/';
	const [x, y] = [norm(a), norm(b)];
	return x.startsWith(y) || y.startsWith(x);
}

/**
 * The other open sessions working in `folder`, from the sessions open in any
 * window (`code_session_open_ids`) and the saved list.
 */
export function sharingFolder(
	selfId: string,
	folder: string,
	openIds: Iterable<string>,
	list: CodeSessionSummary[],
	wslDistro: string | null = null
): CodeSessionSummary[] {
	const open = new Set(openIds);
	return list.filter(
		(s) =>
			s.id !== selfId && open.has(s.id) && rootsOverlap(s.root, folder, [s.wsl_distro, wslDistro])
	);
}

/** The same, asked of Rust and the database. Empty when either fails. */
export async function openSessionsSharing(
	selfId: string,
	folder: string,
	localIds: string[] = [],
	wslDistro: string | null = null
): Promise<CodeSessionSummary[]> {
	try {
		const [ids, list] = await Promise.all([
			invoke<string[] | null>('code_session_open_ids'),
			listCodeSessions()
		]);
		return sharingFolder(selfId, folder, [...(ids ?? []), ...localIds], list ?? [], wslDistro);
	} catch {
		return [];
	}
}

/**
 * The worktree to offer to remove with `session`: the one Haruspex made for
 * it, unless another saved session still works inside it.
 */
export function worktreeOffer(
	session: CodeSessionSummary,
	list: CodeSessionSummary[]
): string | null {
	const wt = session.worktree;
	if (!wt) return null;
	const inUse = list.some(
		(s) => s.id !== session.id && rootsOverlap(s.root, wt, [s.wsl_distro, session.wsl_distro])
	);
	return inUse ? null : wt;
}

/** What to tell the user about the worktree after a delete. */
export function worktreeOutcome(removal: WorktreeRemoval, path: string): string {
	return removal.kind === 'removed'
		? `Removed the worktree ${path}. Its branch is kept.`
		: `Kept the worktree ${path}: ${removal.reason}`;
}
