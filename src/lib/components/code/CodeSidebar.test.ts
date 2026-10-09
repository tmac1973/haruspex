import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('#lib/code/db.ts', () => ({
	listCodeSessions: vi.fn(async () => [
		{ id: 'a1', title: 'Fix lint', root: '/p/haruspex', updated_at: 2, forked_from: null },
		{ id: 'b1', title: 'New post', root: '/p/blog', updated_at: 9, forked_from: null },
		{ id: 'a2', title: 'Code tab', root: '/p/haruspex', updated_at: 5, forked_from: 'a1' },
		{ id: 'c1', title: '/init', root: '/p/cli', updated_at: 7, forked_from: null }
	]),
	deleteCodeSession: vi.fn(),
	updateCodeSessionMeta: vi.fn()
}));
const store = vi.hoisted(() => ({
	openSession: vi.fn(async () => ({})),
	closeSession: vi.fn(),
	getActiveSessionId: vi.fn(() => 'a2'),
	getOpenSessions: vi.fn(() => [])
}));
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
		expect(top).toEqual(['New post', 'cli · new session', 'haruspex']);

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
});
