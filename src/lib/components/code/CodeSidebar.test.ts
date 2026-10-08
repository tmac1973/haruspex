import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('#lib/code/db.ts', () => ({
	listCodeSessions: vi.fn(async () => [
		{ id: 'a1', title: 'Fix lint', root: '/p/haruspex', updated_at: 2, forked_from: null },
		{ id: 'b1', title: 'New post', root: '/p/blog', updated_at: 9, forked_from: null },
		{ id: 'a2', title: 'Code tab', root: '/p/haruspex', updated_at: 5, forked_from: null }
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
	it('groups sessions by folder, newest folder and session first', async () => {
		render(CodeSidebar, { onNew: vi.fn() });
		await waitFor(() => screen.getByText('Fix lint'));
		const folders = screen
			.getAllByRole('button', { expanded: true })
			.map((b) => b.textContent?.replace(/[▾▸]/g, '').trim());
		expect(folders).toEqual(['blog', 'haruspex']);
		const haruspex = screen.getByTitle('/p/haruspex').closest('.group') as HTMLElement;
		expect(
			within(haruspex)
				.getAllByRole('listitem')
				.map((li) => li.textContent?.trim())
		).toEqual(['Code tab', 'Fix lint']);
	});

	it('marks the active session and opens one on click', async () => {
		render(CodeSidebar, { onNew: vi.fn() });
		const active = await waitFor(() => screen.getByRole('button', { name: 'Code tab' }));
		expect(active.classList.contains('active')).toBe(true);
		screen.getByRole('button', { name: 'New post' }).click();
		expect(store.openSession).toHaveBeenCalledWith('b1');
	});
});
