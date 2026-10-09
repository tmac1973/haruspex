import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('#lib/code/db.ts', () => ({
	listCodeSessions: vi.fn(async () => [
		{ id: 'a1', title: 'Fix lint', root: '/p/haruspex', updated_at: 2, forked_from: null },
		{ id: 'b1', title: 'New post', root: '/p/blog', updated_at: 9, forked_from: null },
		{ id: 'a2', title: 'Code tab', root: '/p/haruspex', updated_at: 5, forked_from: 'a1' },
		{ id: 'c1', title: '/init', root: '/p/cli', updated_at: 7, forked_from: null },
		{
			id: 'w1',
			title: 'Try it',
			root: '/p/blog-worktrees/try-it',
			updated_at: 1,
			forked_from: 'b1',
			worktree: '/p/blog-worktrees/try-it'
		}
	]),
	deleteCodeSession: vi.fn(),
	updateCodeSessionMeta: vi.fn()
}));
const store = vi.hoisted(() => ({
	openSession: vi.fn(async () => ({})),
	closeSession: vi.fn(),
	getActiveSessionId: vi.fn(() => 'a2'),
	getOpenSessions: vi.fn(() => []),
	deleteSession: vi.fn(async (): Promise<unknown> => ({ worktree: { kind: 'removed' } }))
}));
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('#lib/stores/toasts.svelte.ts', () => toasts);
vi.mock('#lib/stores/code.svelte.ts', () => store);

import CodeSidebar from './CodeSidebar.svelte';

describe('CodeSidebar', () => {
	it('lists lone sessions flat and groups a folder that has several', async () => {
		render(CodeSidebar, { onNew: vi.fn() });
		await waitFor(() => screen.getByText('Fix lint'));
		const list = screen.getByRole('complementary', { name: 'Code sessions' });
		const top = [...list.querySelectorAll('.list > ul > li')].map(
			(li) => li.querySelector('.name, .folder-name')?.textContent
		);
		expect(top).toEqual(['New post', 'cli · new session', 'haruspex', 'Try it']);

		// A lone session shows its folder under the title.
		const post = screen.getByRole('button', { name: 'New post' });
		expect(post.querySelector('.meta')?.textContent).toMatch(/^blog · /);

		// The folder row: name, count, the full path in its tooltip, newest first inside.
		const folder = screen.getByTitle('/p/haruspex');
		expect(folder.getAttribute('aria-expanded')).toBe('true');
		expect(folder.querySelector('.count')?.textContent).toBe('2');
		const group = folder.closest('li') as HTMLElement;
		expect(
			within(group)
				.getAllByRole('button')
				.slice(1)
				.map((b) => b.getAttribute('aria-label'))
		).toEqual(['Code tab', 'Fix lint']);

		folder.click();
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Fix lint' })).toBeNull());
	});

	it('marks the active session and opens one on click', async () => {
		render(CodeSidebar, { onNew: vi.fn() });
		const active = await waitFor(() => screen.getByRole('button', { name: 'Code tab' }));
		expect(active.classList.contains('active')).toBe(true);
		screen.getByRole('button', { name: 'New post' }).click();
		expect(store.openSession).toHaveBeenCalledWith('b1');
	});

	it('marks a fork with a branch glyph and names its source in the tooltip', async () => {
		render(CodeSidebar, { onNew: vi.fn() });
		const fork = await waitFor(() => screen.getByRole('button', { name: 'Code tab' }));
		expect(fork.querySelector('[data-testid="fork-glyph"]')).not.toBeNull();
		expect(fork.getAttribute('title')).toContain('Forked from "Fix lint"');
		const plain = screen.getByRole('button', { name: 'Fix lint' });
		expect(plain.querySelector('[data-testid="fork-glyph"]')).toBeNull();
	});
});

describe('deleting a session', () => {
	async function deleteFromMenu(name: string) {
		const row = await waitFor(() => screen.getByRole('button', { name }));
		await fireEvent.contextMenu(row);
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
	}

	it('offers to remove the worktree a fork was given, and says what happened', async () => {
		render(CodeSidebar, { onNew: vi.fn() });
		await deleteFromMenu('Try it');
		const box = screen.getByRole('checkbox') as HTMLInputElement;
		expect(box.checked).toBe(true);
		expect(screen.getByText(/Also remove its worktree/).textContent).toContain(
			'/p/blog-worktrees/try-it'
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() =>
			expect(store.deleteSession).toHaveBeenCalledWith('w1', {
				removeWorktree: '/p/blog-worktrees/try-it'
			})
		);
		await waitFor(() =>
			expect(toasts.showToast).toHaveBeenCalledWith(
				'Removed the worktree /p/blog-worktrees/try-it. Its branch is kept.',
				{ kind: 'success' }
			)
		);
	});

	it('keeps a dirty worktree and says so', async () => {
		store.deleteSession.mockResolvedValueOnce({
			worktree: { kind: 'kept', reason: 'it has uncommitted changes.' }
		});
		render(CodeSidebar, { onNew: vi.fn() });
		await deleteFromMenu('Try it');
		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() =>
			expect(toasts.showToast).toHaveBeenCalledWith(
				'Kept the worktree /p/blog-worktrees/try-it: it has uncommitted changes.',
				{ kind: 'info' }
			)
		);
	});

	it('leaves the worktree when the box is unticked, and offers none for other sessions', async () => {
		store.deleteSession.mockClear();
		const { unmount } = render(CodeSidebar, { onNew: vi.fn() });
		await deleteFromMenu('Try it');
		await fireEvent.click(screen.getByRole('checkbox'));
		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() =>
			expect(store.deleteSession).toHaveBeenCalledWith('w1', { removeWorktree: null })
		);
		unmount();
		render(CodeSidebar, { onNew: vi.fn() });
		await deleteFromMenu('New post');
		expect(screen.queryByRole('checkbox')).toBeNull();
	});
});
