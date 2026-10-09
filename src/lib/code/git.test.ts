import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { branchLabel, isDirty, switchBlockedReason, type GitStatus } from './git';

const st = (over: Partial<GitStatus> = {}): GitStatus => ({
	repo_root: '/p',
	branch: 'main',
	head: 'abc1234',
	changed: 0,
	untracked: 0,
	linked_worktree: false,
	default_branch: 'main',
	...over
});

describe('the branch control rules', () => {
	it('labels a detached HEAD with its hash', () => {
		expect(branchLabel(st())).toBe('main');
		expect(branchLabel(st({ branch: null }))).toBe('abc1234');
		expect(branchLabel(st({ branch: null, head: null }))).toBe('no commits');
	});

	it('marks tracked and untracked changes', () => {
		expect(isDirty(st())).toBe(false);
		expect(isDirty(st({ changed: 1 }))).toBe(true);
		expect(isDirty(st({ untracked: 2 }))).toBe(true);
	});

	it('switches only while idle and without tracked changes', () => {
		expect(switchBlockedReason(st(), false)).toBeNull();
		expect(switchBlockedReason(st({ untracked: 3 }), false)).toBeNull();
		expect(switchBlockedReason(st(), true)).toMatch(/Wait for the turn/);
		expect(switchBlockedReason(st({ changed: 2 }), false)).toBe(
			'2 files have uncommitted changes: commit or stash first.'
		);
	});
});
