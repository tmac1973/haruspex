import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

const dedupe = vi.hoisted(() => ({ findDuplicateGroups: vi.fn(), mergeGroup: vi.fn() }));
vi.mock('#lib/agent/memory/dedupe.ts', () => dedupe);
vi.mock('#lib/stores/memory.svelte.ts', () => ({ refreshMemoryCount: vi.fn() }));

import MemoryTidy from './MemoryTidy.svelte';

const group = {
	memories: [
		{ id: 'a', content: 'Builds Haruspex.', origin: 'explicit' },
		{ id: 'b', content: 'Is building Haruspex, a desktop app.', origin: 'extracted' }
	],
	content: 'Builds Haruspex, a local-first desktop app.',
	keepId: 'a'
};

beforeEach(() => {
	dedupe.findDuplicateGroups.mockReset().mockResolvedValue([group]);
	dedupe.mergeGroup.mockReset().mockResolvedValue(undefined);
});

describe('Settings → Memory → Duplicates', () => {
	it('shows each group with its suggestion, and merges the edited text', async () => {
		const onMerged = vi.fn();
		render(MemoryTidy, { props: { onMerged } });
		await fireEvent.click(screen.getByText('Find duplicates'));
		expect(await screen.findByText('Builds Haruspex.')).toBeTruthy();
		expect(screen.getByText('(saved by you)')).toBeTruthy();
		const box = screen.getByLabelText('Merged memory') as HTMLTextAreaElement;
		expect(box.value).toBe(group.content);
		await fireEvent.input(box, { target: { value: 'Builds Haruspex, a desktop AI app.' } });
		await fireEvent.click(screen.getByText('Merge'));
		expect(dedupe.mergeGroup).toHaveBeenCalledWith(
			expect.objectContaining({ keepId: 'a' }),
			'Builds Haruspex, a desktop AI app.'
		);
		expect(onMerged).toHaveBeenCalled();
		expect(screen.queryByText('Builds Haruspex.')).toBeNull();
	});

	it('skips a group without changing anything', async () => {
		render(MemoryTidy, { props: { onMerged: vi.fn() } });
		await fireEvent.click(screen.getByText('Find duplicates'));
		await fireEvent.click(await screen.findByText('Skip'));
		expect(dedupe.mergeGroup).not.toHaveBeenCalled();
		expect(screen.queryByText('Builds Haruspex.')).toBeNull();
	});

	it('says when there is nothing to merge, or the check failed', async () => {
		dedupe.findDuplicateGroups.mockResolvedValueOnce([]);
		render(MemoryTidy, { props: { onMerged: vi.fn() } });
		await fireEvent.click(screen.getByText('Find duplicates'));
		expect(await screen.findByText('No duplicates found.')).toBeTruthy();
		dedupe.findDuplicateGroups.mockRejectedValueOnce('model not ready');
		await fireEvent.click(screen.getByText('Find duplicates'));
		expect(await screen.findByText("Couldn't check: model not ready")).toBeTruthy();
	});
});
