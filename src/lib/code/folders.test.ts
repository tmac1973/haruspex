import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
	absolutePath,
	formatFileNotices,
	leaseRefusal,
	rootsOverlap,
	sharingFolder,
	worktreeOffer,
	worktreeOutcome
} from './folders';
import type { CodeSessionSummary } from './db';

const summary = (over: Partial<CodeSessionSummary>): CodeSessionSummary => ({
	id: 's',
	title: '',
	root: '/p',
	wsl_distro: null,
	updated_at: 0,
	forked_from: null,
	read_only: false,
	worktree: null,
	...over
});

describe('lease and paths', () => {
	it('names the session that has the folder', () => {
		expect(leaseRefusal('Fix login')).toBe(
			'Another session (Fix login) is editing this folder right now; wait for it to finish, or work in a worktree.'
		);
		expect(leaseRefusal('')).toContain('(untitled)');
	});

	it('makes paths absolute against the root', () => {
		expect(absolutePath('/p/app', 'src/a.ts')).toBe('/p/app/src/a.ts');
		expect(absolutePath('/p/app/', './a.ts')).toBe('/p/app/a.ts');
		expect(absolutePath('/p/app', '/etc/x')).toBe('/etc/x');
	});

	it('compares folders by component', () => {
		expect(rootsOverlap('/p/app', '/p/app')).toBe(true);
		expect(rootsOverlap('/p/app/sub', '/p/app')).toBe(true);
		expect(rootsOverlap('/p/app', '/p/app-worktrees/x')).toBe(false);
	});
});

describe('formatFileNotices', () => {
	it('lists each session once, its files relative to the folder', () => {
		const text = formatFileNotices(
			[
				{ session_id: 'a', title: 'Alpha', files: ['/p/a.ts', '/p/src/b.ts'], at: 1 },
				{ session_id: 'a', title: 'Alpha', files: ['/p/a.ts', '/elsewhere/c.ts'], at: 2 },
				{ session_id: 'b', title: '', files: ['/p/d.ts'], at: 3 }
			],
			'/p'
		);
		expect(text).toBe(
			"Since your last turn, session 'Alpha' changed: a.ts, src/b.ts, /elsewhere/c.ts\n" +
				"Since your last turn, session 'untitled' changed: d.ts\n" +
				'Re-read those files before editing them.'
		);
	});

	it('is null when nothing changed, and counts past twenty files', () => {
		expect(formatFileNotices([], '/p')).toBeNull();
		const files = Array.from({ length: 23 }, (_, i) => `/p/f${i}.ts`);
		expect(formatFileNotices([{ session_id: 'a', title: 'A', files, at: 1 }], '/p')).toContain(
			'f19.ts and 3 more'
		);
	});
});

describe('sessions sharing a folder', () => {
	it('lists the other open sessions in or around the folder', () => {
		const list = [
			summary({ id: 'me', root: '/p' }),
			summary({ id: 'open-same', root: '/p' }),
			summary({ id: 'open-sub', root: '/p/sub' }),
			summary({ id: 'closed', root: '/p' }),
			summary({ id: 'open-wt', root: '/p-worktrees/x' })
		];
		const ids = sharingFolder('me', '/p', ['me', 'open-same', 'open-sub', 'open-wt'], list).map(
			(s) => s.id
		);
		expect(ids).toEqual(['open-same', 'open-sub']);
	});
});

describe('deleting a worktree session', () => {
	it('offers its worktree, unless another session still works in it', () => {
		const wt = summary({ id: 'w', root: '/p-worktrees/x/sub', worktree: '/p-worktrees/x' });
		expect(worktreeOffer(wt, [wt])).toBe('/p-worktrees/x');
		const reader = summary({ id: 'r', root: '/p-worktrees/x/sub' });
		expect(worktreeOffer(wt, [wt, reader])).toBeNull();
		expect(worktreeOffer(summary({ id: 'plain' }), [])).toBeNull();
	});

	it('says what happened to it', () => {
		expect(worktreeOutcome({ kind: 'removed' }, '/w')).toBe(
			'Removed the worktree /w. Its branch is kept.'
		);
		expect(worktreeOutcome({ kind: 'kept', reason: 'it has uncommitted changes.' }, '/w')).toBe(
			'Kept the worktree /w: it has uncommitted changes.'
		);
	});
});
