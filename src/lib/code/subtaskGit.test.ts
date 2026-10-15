import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import {
	applySubtaskPatch,
	createSubtaskWorktree,
	discardSessionSubtaskWorktrees,
	discardSubtaskWorktree,
	subtaskWorktreeDiff
} from './subtaskGit';

const mocked = vi.mocked(invoke);

beforeEach(() => {
	mocked.mockReset();
	mocked.mockResolvedValue(undefined);
});

describe('subtask git wrappers', () => {
	it('creates a worktree for a session', async () => {
		await createSubtaskWorktree('/p/sub', 's1');
		expect(mocked).toHaveBeenCalledWith('code_subtask_worktree_create', {
			folder: '/p/sub',
			sessionId: 's1',
			wslDistro: null
		});
	});

	it('diffs a worktree against its base', async () => {
		await subtaskWorktreeDiff('/w/s1-1', 'abc123', 'Ubuntu');
		expect(mocked).toHaveBeenCalledWith('code_subtask_worktree_diff', {
			path: '/w/s1-1',
			base: 'abc123',
			wslDistro: 'Ubuntu'
		});
	});

	it('applies a patch to the folder', async () => {
		mocked.mockResolvedValue({ kind: 'applied', files: ['a.txt'] });
		await expect(applySubtaskPatch('/p', 'diff --git …')).resolves.toEqual({
			kind: 'applied',
			files: ['a.txt']
		});
		expect(mocked).toHaveBeenCalledWith('code_subtask_apply', {
			folder: '/p',
			patch: 'diff --git …',
			wslDistro: null
		});
	});

	it('discards one worktree', async () => {
		await discardSubtaskWorktree('/w/s1-1');
		expect(mocked).toHaveBeenCalledWith('code_subtask_worktree_discard', {
			path: '/w/s1-1',
			wslDistro: null
		});
	});

	it("discards a session's worktrees", async () => {
		await discardSessionSubtaskWorktrees('/p', 's1', 'Ubuntu');
		expect(mocked).toHaveBeenCalledWith('code_subtask_worktrees_discard_session', {
			folder: '/p',
			sessionId: 's1',
			wslDistro: 'Ubuntu'
		});
	});
});
