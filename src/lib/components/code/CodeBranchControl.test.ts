import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const mocks = vi.hoisted(() => ({
	gitBranches: vi.fn(async () => ['feature', 'main']),
	gitSwitch: vi.fn(async () => {}),
	gitCreateBranch: vi.fn(async () => {}),
	openSessionsSharing: vi.fn(async () => [] as { title: string; root: string }[]),
	showToast: vi.fn()
}));
vi.mock('#lib/code/git.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/code/git.ts')>()),
	gitBranches: mocks.gitBranches,
	gitSwitch: mocks.gitSwitch,
	gitCreateBranch: mocks.gitCreateBranch
}));
vi.mock('#lib/code/folders.ts', () => ({ openSessionsSharing: mocks.openSessionsSharing }));
vi.mock('#lib/stores/code.svelte.ts', () => ({ getOpenSessions: () => [] }));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: mocks.showToast }));

import CodeBranchControl from './CodeBranchControl.svelte';
import type { CodeSession } from '#lib/stores/code.svelte.ts';
import type { GitStatus } from '#lib/code/git.ts';

const repo = (over: Partial<GitStatus> = {}): GitStatus => ({
	repo_root: '/p',
	branch: 'main',
	head: 'abc1234',
	changed: 0,
	untracked: 0,
	linked_worktree: false,
	...over
});

function session(over: Record<string, unknown> = {}): CodeSession {
	return {
		id: 's1',
		root: '/p',
		busy: false,
		git: repo(),
		refreshGit: vi.fn(async () => {}),
		...over
	} as unknown as CodeSession;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) m.mockClear();
});

describe('CodeBranchControl', () => {
	it('shows nothing outside a git repository', () => {
		const { container } = render(CodeBranchControl, { session: session({ git: null }) });
		expect(container.querySelector('.branch')).toBeNull();
	});

	it('shows the branch, the ● for uncommitted work, and a detached HEAD by hash', () => {
		const { unmount } = render(CodeBranchControl, { session: session() });
		expect(screen.getByRole('button', { name: 'Branch main' })).toBeTruthy();
		expect(screen.queryByTestId('dirty-marker')).toBeNull();
		unmount();
		render(CodeBranchControl, { session: session({ git: repo({ branch: null, untracked: 1 }) }) });
		expect(
			screen.getByRole('button', { name: /Branch abc1234, uncommitted changes/ })
		).toBeTruthy();
		expect(screen.getByTestId('dirty-marker')).toBeTruthy();
	});

	it('switches to another branch from the menu', async () => {
		const s = session();
		render(CodeBranchControl, { session: s });
		await fireEvent.click(screen.getByRole('button', { name: 'Branch main' }));
		const item = await screen.findByRole('menuitem', { name: 'feature' });
		expect((screen.getByRole('menuitem', { name: 'main' }) as HTMLButtonElement).disabled).toBe(
			true
		);
		await fireEvent.click(item);
		await vi.waitFor(() => expect(mocks.gitSwitch).toHaveBeenCalledWith('/p', 'feature'));
	});

	it('will not switch with uncommitted changes, and says why', async () => {
		render(CodeBranchControl, { session: session({ git: repo({ changed: 1 }) }) });
		await fireEvent.click(screen.getByRole('button', { name: /Branch main/ }));
		const item = (await screen.findByRole('menuitem', { name: 'feature' })) as HTMLButtonElement;
		expect(item.disabled).toBe(true);
		expect(screen.getByText('1 file has uncommitted changes: commit or stash first.')).toBeTruthy();
	});

	it('will not switch while a turn runs', async () => {
		render(CodeBranchControl, { session: session({ busy: true }) });
		await fireEvent.click(screen.getByRole('button', { name: 'Branch main' }));
		expect(await screen.findByText(/Wait for the turn to finish/)).toBeTruthy();
	});

	it("shows git's refusal when a switch fails", async () => {
		mocks.gitSwitch.mockRejectedValueOnce('error: Your local changes would be overwritten');
		render(CodeBranchControl, { session: session() });
		await fireEvent.click(screen.getByRole('button', { name: 'Branch main' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'feature' }));
		await vi.waitFor(() =>
			expect(mocks.showToast).toHaveBeenCalledWith(
				expect.stringContaining('would be overwritten'),
				{ kind: 'error' }
			)
		);
	});

	it('creates a branch', async () => {
		render(CodeBranchControl, { session: session() });
		await fireEvent.click(screen.getByRole('button', { name: 'Branch main' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /New branch/ }));
		const input = screen.getByRole('textbox', { name: 'New branch name' });
		await fireEvent.input(input, { target: { value: 'try-it' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Create' }));
		await vi.waitFor(() => expect(mocks.gitCreateBranch).toHaveBeenCalledWith('/p', 'try-it'));
	});

	it('warns when another open session works in the repository', async () => {
		mocks.openSessionsSharing.mockResolvedValueOnce([{ title: 'Fix login', root: '/p' }]);
		render(CodeBranchControl, { session: session() });
		await fireEvent.click(screen.getByRole('button', { name: 'Branch main' }));
		expect(await screen.findByText(/Also open here: Fix login/)).toBeTruthy();
	});
});
