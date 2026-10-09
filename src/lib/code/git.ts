/**
 * Git for the Code tab: typed wrappers over `code_tools/git.rs`, and the
 * small rules the header's branch control follows.
 */
import { invoke } from '@tauri-apps/api/core';
import type { GitStatus } from '#lib/ipc/gen/GitStatus.ts';
import type { WorktreeRemoval } from '#lib/ipc/gen/WorktreeRemoval.ts';

export type { GitStatus, WorktreeRemoval };

/** The folder's git state; null without git, outside a repo, or on failure. */
export async function gitStatus(folder: string): Promise<GitStatus | null> {
	try {
		return (await invoke<GitStatus | null>('code_git_status', { folder })) ?? null;
	} catch {
		return null;
	}
}

export function gitBranches(folder: string): Promise<string[]> {
	return invoke<string[]>('code_git_branches', { folder });
}

/** Check out `branch`. Rejects with git's own message when it refuses. */
export function gitSwitch(folder: string, branch: string): Promise<void> {
	return invoke<void>('code_git_switch', { folder, branch });
}

/** Create `branch` at HEAD and check it out. */
export function gitCreateBranch(folder: string, branch: string): Promise<void> {
	return invoke<void>('code_git_create_branch', { folder, branch });
}

/** Remove a worktree Haruspex made, only if it is clean. */
export function removeWorktree(path: string): Promise<WorktreeRemoval> {
	return invoke<WorktreeRemoval>('code_git_worktree_remove', { path });
}

/** The branch, or the short hash on a detached HEAD. */
export function branchLabel(status: GitStatus): string {
	return status.branch ?? (status.head ? status.head : 'no commits');
}

/** Uncommitted work of any kind: the ● in the header. */
export function isDirty(status: GitStatus): boolean {
	return status.changed > 0 || status.untracked > 0;
}

/**
 * Why the branch can't be switched right now, or null. Git refuses a
 * checkout that would overwrite changes; we don't stash for the user.
 */
export function switchBlockedReason(status: GitStatus, busy: boolean): string | null {
	if (busy) return 'Wait for the turn to finish before switching branch.';
	if (status.changed > 0) {
		const files = status.changed === 1 ? '1 file has' : `${status.changed} files have`;
		return `${files} uncommitted changes: commit or stash first.`;
	}
	return null;
}
