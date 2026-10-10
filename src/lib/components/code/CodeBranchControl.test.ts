import { tick } from 'svelte';
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
	default_branch: 'main',
	...over
});

function session(over: Record<string, unknown> = {}): CodeSession {
	return {
		id: 's1',
		root: '/p',
		wslDistro: null,
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
		await vi.waitFor(() => expect(mocks.gitSwitch).toHaveBeenCalledWith('/p', 'feature', null));
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
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Branch from current/ }));
		const input = screen.getByRole('textbox', { name: 'New branch name' });
		await fireEvent.input(input, { target: { value: 'try-it' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Create' }));
		await vi.waitFor(() =>
			expect(mocks.gitCreateBranch).toHaveBeenCalledWith('/p', 'try-it', undefined, null)
		);
	});

	it('keeps the menu open when the clicked item leaves the page mid-click', async () => {
		// In the app, "New branch…" swaps itself for the name form before the
		// click reaches the window, so its target is detached by then.
		render(CodeBranchControl, { session: session() });
		await fireEvent.click(screen.getByRole('button', { name: 'Branch main' }));
		const menu = await screen.findByTestId('branch-menu');
		const detached = document.createElement('button');
		const click = new MouseEvent('click', { bubbles: true });
		Object.defineProperty(click, 'target', { value: detached });
		const ancestors: EventTarget[] = [];
		for (let el: Element | null = menu; el; el = el.parentElement) ancestors.push(el);
		Object.defineProperty(click, 'composedPath', { value: () => [detached, ...ancestors] });
		window.dispatchEvent(click);
		await tick();
		expect(screen.queryByTestId('branch-menu')).not.toBeNull();
	});

	it('branches from the default branch when asked', async () => {
		render(CodeBranchControl, { session: session({ git: repo({ branch: 'feature' }) }) });
		await fireEvent.click(screen.getByRole('button', { name: 'Branch feature' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Branch from main/ }));
		const input = screen.getByRole('textbox', { name: 'New branch name' });
		await fireEvent.input(input, { target: { value: 'hotfix' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Create' }));
		await vi.waitFor(() =>
			expect(mocks.gitCreateBranch).toHaveBeenCalledWith('/p', 'hotfix', 'main', null)
		);
	});

	it('offers no "from main" while main is checked out', async () => {
		render(CodeBranchControl, { session: session() });
		await fireEvent.click(screen.getByRole('button', { name: 'Branch main' }));
		await screen.findByRole('menuitem', { name: /Branch from current/ });
		expect(screen.queryByRole('menuitem', { name: /Branch from main/ })).toBeNull();
	});

	it('warns when another open session works in the repository', async () => {
		mocks.openSessionsSharing.mockResolvedValueOnce([{ title: 'Fix login', root: '/p' }]);
		render(CodeBranchControl, { session: session() });
		await fireEvent.click(screen.getByRole('button', { name: 'Branch main' }));
		expect(await screen.findByText(/Also open here: Fix login/)).toBeTruthy();
	});
});
