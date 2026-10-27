/**
 * Bringing a writing subtask's changes back to its session's folder.
 *
 * The child worked in its own worktree (`subtaskGit.ts`). Once it is done its
 * changes come back as one patch, applied under the session's write lease and
 * one subtask at a time per session, in the order they finish: directly when
 * it applies, through a three-way merge when the folder changed meanwhile,
 * and not at all on a conflict, which leaves the worktree for the parent to
 * work from.
 */
import type { CodeWriteGuard } from '#lib/agent/tools/types.ts';
import {
	applySubtaskPatch,
	discardSubtaskWorktree,
	subtaskWorktreeDiff,
	type SubtaskWorktree
} from '#lib/code/subtaskGit.ts';
import { logDebug } from '#lib/debug-log.ts';
import { errMessage } from '#lib/utils/error.ts';
import { sleep } from '#lib/utils/async.ts';

/** What became of a writing subtask's changes. */
export interface SubtaskApplyState {
	/**
	 * none: it changed nothing. applied: its changes are in the folder.
	 * conflict: they clash with the folder's; the worktree is kept.
	 * discarded: it stopped or failed, and its changes were dropped.
	 * kept: stopped while waiting for the folder; the worktree is kept.
	 */
	status: 'none' | 'applied' | 'conflict' | 'discarded' | 'kept';
	/** Files the patch touched, relative to the repository. */
	files: string[];
	/** The kept worktree, for a conflict or a stop. */
	worktree?: string;
	/** Git's account of a conflict. */
	message?: string;
}

/** What the parent needs beyond the card: the patch, when it wasn't applied. */
export interface SubtaskApplyOutcome {
	state: SubtaskApplyState;
	patch?: string;
}

/** How long to wait between asks while another session holds the folder. */
export const LEASE_RETRY_MS = 2000;

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after every apply of `sessionId` already started has finished. */
export function withApplyLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(sessionId) ?? Promise.resolve();
	const run = prev.then(fn, fn);
	const tail = run.catch(() => {});
	locks.set(sessionId, tail);
	void tail.then(() => {
		if (locks.get(sessionId) === tail) locks.delete(sessionId);
	});
	return run;
}

/**
 * The session folder's repository top, from where the subtask's worktree put
 * that folder: the patch's paths are relative to the top.
 */
export function repoTopOf(sessionRoot: string, wt: Pick<SubtaskWorktree, 'path' | 'root'>): string {
	const trim = (p: string) => p.replace(/[\\/]+$/, '');
	const top = trim(wt.path);
	const root = trim(wt.root);
	if (root === top || !root.startsWith(top)) return trim(sessionRoot);
	const rel = root.slice(top.length);
	const here = trim(sessionRoot);
	return here.endsWith(rel) ? here.slice(0, here.length - rel.length) : here;
}

/** `file` (relative to the repository top) as an absolute path. */
export function repoFile(top: string, file: string): string {
	const sep = top.includes('\\') && !top.includes('/') ? '\\' : '/';
	return `${top}${sep}${file.split('/').join(sep)}`;
}

/** Remove a worktree, logging rather than failing when it can't be. */
export async function discardQuietly(wt: SubtaskWorktree, wslDistro: string | null): Promise<void> {
	try {
		await discardSubtaskWorktree(wt.path, wslDistro);
	} catch (e) {
		logDebug('code', 'discarding a subtask worktree failed', { error: errMessage(e) });
	}
}

/**
 * Apply a finished subtask's changes to `folder` (the session's), and tidy
 * its worktree away unless the changes need it kept.
 */
export async function applySubtaskChanges(o: {
	sessionId: string;
	folder: string;
	wslDistro: string | null;
	wt: SubtaskWorktree;
	guard?: CodeWriteGuard;
	/** The child's own signal: its stop ends a wait for the folder. */
	signal?: AbortSignal;
}): Promise<SubtaskApplyOutcome> {
	const { patch, files } = await subtaskWorktreeDiff(o.wt.path, o.wt.base, o.wslDistro);
	if (!patch.trim()) {
		await discardQuietly(o.wt, o.wslDistro);
		return { state: { status: 'none', files: [] } };
	}
	return withApplyLock(o.sessionId, async () => {
		// Another session may be writing in the folder: wait for it.
		while (o.guard) {
			const refused = await o.guard.acquire();
			if (refused === null) break;
			if (o.signal?.aborted) {
				return { state: { status: 'kept', files, worktree: o.wt.path }, patch };
			}
			await sleep(LEASE_RETRY_MS, o.signal);
		}
		const res = await applySubtaskPatch(o.folder, patch, o.wslDistro);
		if (res.kind === 'conflict') {
			return {
				state: { status: 'conflict', files: res.files, worktree: o.wt.path, message: res.message },
				patch
			};
		}
		const top = repoTopOf(o.folder, o.wt);
		o.guard?.changed(res.files.map((f) => repoFile(top, f)));
		await discardQuietly(o.wt, o.wslDistro);
		return { state: { status: 'applied', files: res.files } };
	});
}
