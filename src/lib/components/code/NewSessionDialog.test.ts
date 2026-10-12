import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
const git = vi.hoisted(() => ({ gitStatus: vi.fn(async (): Promise<unknown> => null) }));
vi.mock('#lib/code/git.ts', () => git);
const store = vi.hoisted(() => ({
	newSession: vi.fn(async (root: string) => ({ root, wslDistro: null }))
}));
vi.mock('#lib/stores/code.svelte.ts', () => store);
const settings = vi.hoisted(() => ({
	values: { codeLastRoot: '/work', codeLastWslDistro: '', codeNewWorktree: false },
	getSettings: vi.fn(() => settings.values),
	updateSettings: vi.fn()
}));
vi.mock('#lib/stores/settings.ts', () => settings);
vi.mock('#lib/code/db.ts', () => ({
	resolveCodeFolder: vi.fn(),
	wslDistros: vi.fn(async () => [])
}));

import NewSessionDialog from './NewSessionDialog.svelte';

beforeEach(() => {
	vi.clearAllMocks();
	settings.values = { codeLastRoot: '/work', codeLastWslDistro: '', codeNewWorktree: false };
});

describe('NewSessionDialog', () => {
	it('offers no worktree outside a git repository', async () => {
		render(NewSessionDialog, { open: true, onclose: vi.fn() });
		await waitFor(() => expect(git.gitStatus).toHaveBeenCalledWith('/work', null));
		expect(screen.queryByLabelText('Work in a new worktree')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
		expect(store.newSession).toHaveBeenCalledWith('/work', { wslDistro: null, worktree: false });
		// The remembered choice is left alone when it wasn't offered.
		expect(settings.updateSettings).toHaveBeenCalledWith({
			codeLastRoot: '/work',
			codeLastWslDistro: ''
		});
	});

	it('starts in a worktree when ticked, and remembers the choice and the repository', async () => {
		git.gitStatus.mockResolvedValue({ branch: 'main' });
		store.newSession.mockResolvedValueOnce({
			root: '/work-worktrees/session',
			wslDistro: null
		});
		render(NewSessionDialog, { open: true, onclose: vi.fn() });
		const box = (await screen.findByLabelText('Work in a new worktree')) as HTMLInputElement;
		expect(box.checked).toBe(false);
		await fireEvent.click(box);
		await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
		expect(store.newSession).toHaveBeenCalledWith('/work', { wslDistro: null, worktree: true });
		expect(settings.updateSettings).toHaveBeenCalledWith({
			codeLastRoot: '/work',
			codeLastWslDistro: '',
			codeNewWorktree: true
		});
	});

	it('starts ticked when the last session used a worktree', async () => {
		git.gitStatus.mockResolvedValue({ branch: 'main' });
		settings.values = { ...settings.values, codeNewWorktree: true };
		render(NewSessionDialog, { open: true, onclose: vi.fn() });
		const box = (await screen.findByLabelText('Work in a new worktree')) as HTMLInputElement;
		expect(box.checked).toBe(true);
	});
});
