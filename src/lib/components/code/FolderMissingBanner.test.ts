import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';

const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => dialog);
const store = vi.hoisted(() => ({
	deleteSession: vi.fn(async (): Promise<unknown> => ({ worktree: null }))
}));
vi.mock('#lib/stores/code.svelte.ts', () => store);
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('#lib/stores/toasts.svelte.ts', () => toasts);

import FolderMissingBanner from './FolderMissingBanner.svelte';
import type { CodeSession } from '#lib/stores/code.svelte.ts';

function fakeSession(over: Partial<Record<string, unknown>> = {}): CodeSession {
	return {
		id: 's1',
		root: '/gone/app',
		busy: false,
		folderMissing: true,
		moveTo: vi.fn(async () => {}),
		...over
	} as unknown as CodeSession;
}

describe('FolderMissingBanner', () => {
	it('names the folder and offers no way to make it again', () => {
		render(FolderMissingBanner, { session: fakeSession() });
		const banner = screen.getByRole('alert');
		expect(banner.textContent).toContain('Folder not found: /gone/app');
		const labels = screen.getAllByRole('button').map((b) => b.textContent?.trim());
		expect(labels).toEqual(['Choose folder…', 'Delete session']);
	});

	it('points the session at a chosen folder after asking', async () => {
		const session = fakeSession();
		dialog.open.mockResolvedValueOnce('/found/app');
		render(FolderMissingBanner, { session });
		await fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
		await waitFor(() => screen.getByText('Use this folder?'));
		expect(session.moveTo).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Use folder' }));
		expect(session.moveTo).toHaveBeenCalledWith('/found/app');
	});

	it('does nothing when the picker is cancelled, and says when the move fails', async () => {
		const session = fakeSession({ moveTo: vi.fn(async () => Promise.reject(new Error('nope'))) });
		dialog.open.mockResolvedValueOnce(null);
		render(FolderMissingBanner, { session });
		await fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
		expect(screen.queryByText('Use this folder?')).toBeNull();
		dialog.open.mockResolvedValueOnce('/x');
		await fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Use folder' }));
		await waitFor(() =>
			expect(toasts.showToast).toHaveBeenCalledWith("Couldn't use that folder: nope", {
				kind: 'error'
			})
		);
	});

	it('deletes the session after asking', async () => {
		const ondeleted = vi.fn();
		render(FolderMissingBanner, { session: fakeSession(), ondeleted });
		await fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));
		await waitFor(() => screen.getByText('Delete session?'));
		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(ondeleted).toHaveBeenCalled());
		expect(store.deleteSession).toHaveBeenCalledWith('s1');
	});
});
