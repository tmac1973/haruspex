import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import type { MemoryMeta } from '#lib/ipc/gen/MemoryMeta.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/memory.svelte.ts', () => ({ refreshMemoryCount: vi.fn() }));

import MemoryList from './MemoryList.svelte';

function memory(over: Partial<MemoryMeta> = {}): MemoryMeta {
	return {
		id: 'mem-1',
		content: 'Prefers tabs over spaces.',
		category: 'preference',
		source_conversation_id: 'conv-1',
		source_title: 'Editor setup',
		created_at: Date.UTC(2026, 7, 1),
		last_seen_at: Date.UTC(2026, 7, 20),
		use_count: 3,
		origin: 'extracted',
		...over
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(invoke).mockResolvedValue([]);
});

describe('MemoryList', () => {
	it('lists what is remembered, with where it came from', async () => {
		vi.mocked(invoke).mockResolvedValueOnce([memory()]);
		render(MemoryList);

		expect(await screen.findByText('Prefers tabs over spaces.')).toBeTruthy();
		expect(screen.getByText(/Editor setup/)).toBeTruthy();
		expect(screen.getByText('preference')).toBeTruthy();
	});

	/**
	 * A memory outlives the conversation it came from — deleting a chat must
	 * not hide a fact still being recalled, so the row stays and says so.
	 */
	it('says so when the source conversation is gone', async () => {
		vi.mocked(invoke).mockResolvedValueOnce([memory({ source_title: null })]);
		render(MemoryList);
		expect(await screen.findByText(/from a deleted chat/)).toBeTruthy();
	});

	it('shows an empty state rather than a bare list', async () => {
		render(MemoryList);
		expect(await screen.findByText('Nothing remembered yet.')).toBeTruthy();
	});

	it('re-queries with the filter text', async () => {
		vi.mocked(invoke).mockResolvedValueOnce([memory()]);
		render(MemoryList);
		await screen.findByText('Prefers tabs over spaces.');

		vi.mocked(invoke).mockResolvedValueOnce([]);
		await fireEvent.input(screen.getByLabelText('Filter memories'), {
			target: { value: 'toronto' }
		});

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				'memory_list',
				expect.objectContaining({ filter: 'toronto' })
			)
		);
	});

	/**
	 * Content and embedding are two halves of one fact; Rust re-embeds on
	 * update so an edited memory is recalled for what it now says.
	 */
	it('saves an edit through memory_update', async () => {
		vi.mocked(invoke).mockResolvedValueOnce([memory()]);
		render(MemoryList);
		await screen.findByText('Prefers tabs over spaces.');

		await fireEvent.click(screen.getByText('Edit'));
		const box = screen.getByLabelText('Memory text');
		await fireEvent.input(box, { target: { value: 'Prefers spaces after all.' } });
		await fireEvent.click(screen.getByText('Save'));

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith('memory_update', {
				id: 'mem-1',
				content: 'Prefers spaces after all.'
			})
		);
	});

	it('treats an emptied edit as a cancel, not a silent wipe', async () => {
		vi.mocked(invoke).mockResolvedValueOnce([memory()]);
		render(MemoryList);
		await screen.findByText('Prefers tabs over spaces.');

		await fireEvent.click(screen.getByText('Edit'));
		await fireEvent.input(screen.getByLabelText('Memory text'), { target: { value: '   ' } });
		await fireEvent.click(screen.getByText('Save'));

		await waitFor(() => expect(screen.getByText('Prefers tabs over spaces.')).toBeTruthy());
		expect(invoke).not.toHaveBeenCalledWith('memory_update', expect.anything());
	});

	it('deletes a row without a confirmation step', async () => {
		// One row, its text in front of you: a modal per row makes clearing
		// out bad extractions tedious enough that people stop.
		vi.mocked(invoke).mockResolvedValueOnce([memory()]);
		render(MemoryList);
		await screen.findByText('Prefers tabs over spaces.');

		await fireEvent.click(screen.getByText('Delete'));

		await waitFor(() => expect(invoke).toHaveBeenCalledWith('memory_delete', { id: 'mem-1' }));
		await waitFor(() => expect(screen.queryByText('Prefers tabs over spaces.')).toBeNull());
	});

	describe('clear all', () => {
		it('requires the word to be typed before it will fire', async () => {
			vi.mocked(invoke).mockResolvedValueOnce([memory()]);
			render(MemoryList);
			await screen.findByText('Prefers tabs over spaces.');

			await fireEvent.click(screen.getByText('Forget everything…'));
			const button = screen.getByText('Delete everything') as HTMLButtonElement;
			expect(button.disabled).toBe(true);

			await fireEvent.input(screen.getByLabelText('Type delete to confirm'), {
				target: { value: 'delete' }
			});
			expect((screen.getByText('Delete everything') as HTMLButtonElement).disabled).toBe(false);

			await fireEvent.click(screen.getByText('Delete everything'));
			await waitFor(() => expect(invoke).toHaveBeenCalledWith('memory_delete_all'));
		});

		it('is not offered when there is nothing to forget', async () => {
			render(MemoryList);
			await screen.findByText('Nothing remembered yet.');
			expect(screen.queryByText('Forget everything…')).toBeNull();
		});
	});
});
