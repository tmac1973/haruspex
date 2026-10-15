import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeWriteGuard } from '#lib/agent/tools/types.ts';
import type { SubtaskWorktree } from '#lib/code/subtaskGit.ts';

const git = vi.hoisted(() => ({
	diff: vi.fn(),
	apply: vi.fn(),
	discard: vi.fn()
}));
vi.mock('#lib/code/subtaskGit.ts', () => ({
	subtaskWorktreeDiff: git.diff,
	applySubtaskPatch: git.apply,
	discardSubtaskWorktree: git.discard
}));

import {
	applySubtaskChanges,
	LEASE_RETRY_MS,
	repoFile,
	repoTopOf,
	withApplyLock
} from '#lib/code/subtaskApply.ts';

const wt: SubtaskWorktree = {
	path: '/r-worktrees/.subtasks/s1-1',
	root: '/r-worktrees/.subtasks/s1-1/app',
	base: 'abc123',
	linked: ['node_modules']
};

function guard(refusals = 0) {
	let left = refusals;
	return {
		acquire: vi.fn<CodeWriteGuard['acquire']>(async () =>
			left-- > 0 ? 'Another session is editing this folder.' : null
		),
		changed: vi.fn<CodeWriteGuard['changed']>()
	};
}

const run = (over: Partial<Parameters<typeof applySubtaskChanges>[0]> = {}) =>
	applySubtaskChanges({ sessionId: 's1', folder: '/r/app', wslDistro: null, wt, ...over });

beforeEach(() => {
	git.diff
		.mockReset()
		.mockResolvedValue({ patch: 'diff --git a/app/x b/app/x\n', files: ['app/x'] });
	git.apply.mockReset().mockResolvedValue({ kind: 'applied', files: ['app/x'] });
	git.discard.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('applySubtaskChanges', () => {
	it('tidies away a subtask that changed nothing', async () => {
		git.diff.mockResolvedValue({ patch: '', files: [] });
		const g = guard();
		expect((await run({ guard: g })).state).toEqual({ status: 'none', files: [] });
		expect(g.acquire).not.toHaveBeenCalled();
		expect(git.apply).not.toHaveBeenCalled();
		expect(git.discard).toHaveBeenCalledWith(wt.path, null);
	});

	it('applies under the folder lease, reports the files, and removes the copy', async () => {
		const g = guard();
		const out = await run({ guard: g });
		expect(out.state).toEqual({ status: 'applied', files: ['app/x'] });
		expect(git.apply).toHaveBeenCalledWith('/r/app', 'diff --git a/app/x b/app/x\n', null);
		expect(g.changed).toHaveBeenCalledWith(['/r/app/x']);
		expect(git.discard).toHaveBeenCalledWith(wt.path, null);
	});

	it('keeps the copy and hands back the patch on a conflict', async () => {
		git.apply.mockResolvedValue({ kind: 'conflict', files: ['app/x'], message: 'patch failed' });
		const g = guard();
		const out = await run({ guard: g });
		expect(out.state).toEqual({
			status: 'conflict',
			files: ['app/x'],
			worktree: wt.path,
			message: 'patch failed'
		});
		expect(out.patch).toContain('diff --git');
		expect(g.changed).not.toHaveBeenCalled();
		expect(git.discard).not.toHaveBeenCalled();
	});

	it('waits while another session holds the folder, then applies', async () => {
		vi.useFakeTimers();
		const g = guard(2);
		const p = run({ guard: g });
		await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS * 2);
		expect((await p).state.status).toBe('applied');
		expect(g.acquire).toHaveBeenCalledTimes(3);
	});

	it('keeps the copy when stopped while waiting for the folder', async () => {
		vi.useFakeTimers();
		const stop = new AbortController();
		const p = run({ guard: guard(99), signal: stop.signal });
		await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS);
		stop.abort();
		await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS);
		const out = await p;
		expect(out.state).toEqual({ status: 'kept', files: ['app/x'], worktree: wt.path });
		expect(git.apply).not.toHaveBeenCalled();
		expect(git.discard).not.toHaveBeenCalled();
	});
});

describe('withApplyLock', () => {
	it('runs one session’s applies one after another, others alongside', async () => {
		const order: string[] = [];
		let release!: () => void;
		const first = withApplyLock('s', () =>
			new Promise<void>((r) => (release = r)).then(() => {
				order.push('first');
			})
		);
		const second = withApplyLock('s', async () => {
			order.push('second');
		});
		await withApplyLock('other', async () => {
			order.push('other');
		});
		expect(order).toEqual(['other']);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(['other', 'first', 'second']);
	});

	it('goes on after a failed apply', async () => {
		await expect(
			withApplyLock('f', async () => Promise.reject(new Error('git')))
		).rejects.toThrow();
		expect(await withApplyLock('f', async () => 'next')).toBe('next');
	});
});

describe('repository paths', () => {
	it('finds the repository top of a session in a subfolder', () => {
		expect(repoTopOf('/r/app', wt)).toBe('/r');
		expect(repoTopOf('/r', { path: '/w', root: '/w' })).toBe('/r');
		expect(repoFile('/r', 'app/x.ts')).toBe('/r/app/x.ts');
		expect(repoFile('C:\\r', 'app/x.ts')).toBe('C:\\r\\app\\x.ts');
	});
});
