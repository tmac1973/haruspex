/**
 * Git for writing subtasks: typed wrappers over `code_tools/subtask_git.rs`.
 * A child gets a detached worktree made from a snapshot of the session's
 * folder; its changes come back as a patch applied to the folder, merged
 * three ways when the folder changed meanwhile. `wslDistro`: the session is
 * inside that WSL distro, and git runs there on its Linux paths.
 */
import { invoke } from '@tauri-apps/api/core';
import type { SubtaskApply } from '#lib/ipc/gen/SubtaskApply.ts';
import type { SubtaskPatch } from '#lib/ipc/gen/SubtaskPatch.ts';
import type { SubtaskWorktree } from '#lib/ipc/gen/SubtaskWorktree.ts';

export type { SubtaskApply, SubtaskPatch, SubtaskWorktree };

/**
 * A worktree for a subtask of `sessionId`, from `folder` as it is now
 * (uncommitted and untracked files included). Rejects outside a repository.
 */
export function createSubtaskWorktree(
	folder: string,
	sessionId: string,
	wslDistro: string | null = null
): Promise<SubtaskWorktree> {
	return invoke<SubtaskWorktree>('code_subtask_worktree_create', {
		folder,
		sessionId,
		wslDistro
	});
}

/** The subtask's changes since `base`; an empty patch means none. */
export function subtaskWorktreeDiff(
	path: string,
	base: string,
	wslDistro: string | null = null
): Promise<SubtaskPatch> {
	return invoke<SubtaskPatch>('code_subtask_worktree_diff', { path, base, wslDistro });
}

/** Apply a subtask's patch to `folder`. On a conflict nothing is written. */
export function applySubtaskPatch(
	folder: string,
	patch: string,
	wslDistro: string | null = null
): Promise<SubtaskApply> {
	return invoke<SubtaskApply>('code_subtask_apply', { folder, patch, wslDistro });
}

/** Remove a subtask's worktree; the folders it linked in are left alone. */
export function discardSubtaskWorktree(
	path: string,
	wslDistro: string | null = null
): Promise<void> {
	return invoke<void>('code_subtask_worktree_discard', { path, wslDistro });
}

/** Remove every subtask worktree `sessionId` made in `folder`'s repository. */
export function discardSessionSubtaskWorktrees(
	folder: string,
	sessionId: string,
	wslDistro: string | null = null
): Promise<void> {
	return invoke<void>('code_subtask_worktrees_discard_session', {
		folder,
		sessionId,
		wslDistro
	});
}
