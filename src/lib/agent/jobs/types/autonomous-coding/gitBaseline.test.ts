import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobRunContext } from '../types';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { ensureGitBaseline } from './pipeline';

/**
 * The run's working branch is decided here, once, before anything is
 * committed. Getting it wrong is not recoverable by a later step: commits
 * either land on the user's branch (the bug this option exists to prevent) or
 * a resumed run forks its own history onto a second branch.
 *
 * The three cases the option has to distinguish are all "does `git checkout
 * -b` run?", so that is what these assert against a fake git.
 */

interface FakeRepo {
	inRepo: boolean;
	/** null = unborn HEAD (no commits yet). */
	head: string | null;
	branch: string;
	dirty: boolean;
	/** Non-zero → `git checkout -b` fails. */
	checkoutExit: number;
}

const BRANCH_RE = /^git checkout -b haruspex\/autonomous-coding\/\d+$/;

let commands: string[] = [];

function fakeGit(overrides: Partial<FakeRepo> = {}): FakeRepo {
	const repo: FakeRepo = {
		inRepo: true,
		head: 'abc1234',
		branch: 'main',
		dirty: false,
		checkoutExit: 0,
		...overrides
	};
	commands = [];

	const result = (exit_code: number | null, stdout = '', stderr = '') => ({
		stdout,
		stderr,
		exit_code,
		duration_ms: 1,
		killed: false
	});

	const runGit = (command: string) => {
		if (command === 'git rev-parse --is-inside-work-tree') {
			return repo.inRepo ? result(0, 'true') : result(128, '', 'not a git repository');
		}
		if (command === 'git init') {
			repo.inRepo = true;
			return result(0, 'Initialized empty Git repository');
		}
		if (command === 'git rev-parse HEAD') {
			return repo.head === null
				? result(128, '', "fatal: ambiguous argument 'HEAD'")
				: result(0, `${repo.head}\n`);
		}
		if (command === 'git branch --show-current') return result(0, `${repo.branch}\n`);
		if (BRANCH_RE.test(command)) {
			if (repo.checkoutExit !== 0) return result(repo.checkoutExit, '', 'fatal: cannot lock ref');
			repo.branch = command.slice('git checkout -b '.length);
			return result(0);
		}
		if (command === 'git status --porcelain') return result(0, repo.dirty ? ' M src/a.ts\n' : '');
		if (command === 'git add -A') return result(0);
		if (command.startsWith('git commit')) {
			repo.head = 'def5678';
			repo.dirty = false;
			return result(0, '1 file changed');
		}
		if (command === 'git reset --soft HEAD~1') return result(0);
		throw new Error(`unexpected git command: ${command}`);
	};

	mocks.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
		// fs_path_exists is the only marker probe ensureGitignore makes — no
		// stack markers, so it leaves .gitignore alone and stays out of the way
		// of these assertions.
		if (cmd === 'fs_path_exists') return false;
		if (cmd === 'fs_read_text_full') return '';
		if (cmd === 'fs_write_text') return null;
		if (cmd !== 'run_command_capture') throw new Error(`unexpected invoke: ${cmd}`);

		const command = args.command as string;
		commands.push(command);
		return runGit(command);
	});

	return repo;
}

function ctx(): JobRunContext {
	return { job: { working_dir: '/tmp/repo' } } as unknown as JobRunContext;
}

const checkouts = () => commands.filter((c) => c.startsWith('git checkout -b'));

beforeEach(() => {
	mocks.invoke.mockReset();
});

describe('ensureGitBaseline — working branch', () => {
	it('moves an existing repo onto a fresh timestamped run branch', async () => {
		const repo = fakeGit({ branch: 'main', head: 'abc1234', dirty: true });

		await ensureGitBaseline(ctx(), 'unsigned', true);

		expect(checkouts()).toHaveLength(1);
		expect(checkouts()[0]).toMatch(BRANCH_RE);
		expect(repo.branch).toMatch(/^haruspex\/autonomous-coding\/\d+$/);
	});

	it('creates the branch before the baseline commit, not after', async () => {
		// Ordering is the whole point: a baseline committed first would land on
		// the user's branch, which is exactly what the option prevents.
		fakeGit({ branch: 'main', head: 'abc1234', dirty: true });

		await ensureGitBaseline(ctx(), 'unsigned', true);

		const branchAt = commands.findIndex((c) => c.startsWith('git checkout -b'));
		const commitAt = commands.findIndex((c) => c.startsWith('git commit'));
		expect(branchAt).toBeGreaterThanOrEqual(0);
		expect(commitAt).toBeGreaterThan(branchAt);
	});

	it('leaves a brand-new repo on its default branch', async () => {
		// Unborn HEAD: the repo's entire history IS this run, so there is
		// nothing to keep the run's commits away from.
		const repo = fakeGit({ inRepo: false, head: null, branch: 'main', dirty: true });

		await ensureGitBaseline(ctx(), 'unsigned', true);

		expect(commands).toContain('git init');
		expect(checkouts()).toEqual([]);
		expect(repo.branch).toBe('main');
		// Still baselined — the loop needs a rollback point either way.
		expect(commands.some((c) => c.startsWith('git commit'))).toBe(true);
	});

	it('stays put when the run is resuming on its own branch', async () => {
		// A second checkout -b here would fork the resumed run's work onto a
		// new branch and orphan everything the first run committed.
		const repo = fakeGit({ branch: 'haruspex/autonomous-coding/1700000000000', head: 'abc1234' });

		await ensureGitBaseline(ctx(), 'unsigned', true);

		expect(checkouts()).toEqual([]);
		expect(repo.branch).toBe('haruspex/autonomous-coding/1700000000000');
	});

	it('treats a lookalike branch name as the user’s own', async () => {
		// Only the exact `haruspex/autonomous-coding/<digits>` shape counts as
		// "already the run's branch"; anything else is a branch to protect.
		fakeGit({ branch: 'haruspex/autonomous-coding/manual-retry', head: 'abc1234' });

		await ensureGitBaseline(ctx(), 'unsigned', true);

		expect(checkouts()).toHaveLength(1);
	});

	it('does not touch branches when the option is off', async () => {
		const repo = fakeGit({ branch: 'main', head: 'abc1234', dirty: true });

		await ensureGitBaseline(ctx(), 'unsigned', false);

		expect(checkouts()).toEqual([]);
		expect(repo.branch).toBe('main');
	});

	it('fails loudly when the branch cannot be created', async () => {
		// Surfacing here, at kickoff with the user present, beats a confusing
		// baseline error one step into the unattended stretch.
		fakeGit({ branch: 'main', head: 'abc1234', dirty: true, checkoutExit: 128 });

		await expect(ensureGitBaseline(ctx(), 'unsigned', true)).rejects.toThrow(
			/Could not create working branch haruspex\/autonomous-coding\/\d+.*cannot lock ref/
		);
		// And nothing was committed onto the user's branch on the way out.
		expect(commands.some((c) => c.startsWith('git commit'))).toBe(false);
	});
});
