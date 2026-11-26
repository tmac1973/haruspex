import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import NotebookList from './NotebookList.svelte';
import { pickFromRowMenu, renderRowMenuHost } from '#lib/testing/rowMenu.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({})
);

const store = vi.hoisted(() => ({
	list: [] as unknown[],
	patchNotebook: vi.fn(async () => {}),
	trashNotebook: vi.fn(async () => {})
}));
vi.mock('#lib/stores/notebooks.svelte.ts', () => ({
	allTags: () => [],
	getNotebookList: () => store.list,
	getOpenNotebookId: () => null,
	getTagFilter: () => null,
	isTrashShown: () => false,
	newNotebook: vi.fn(),
	openNotebook: vi.fn(),
	openNotebookOn: vi.fn(),
	openTrash: vi.fn(),
	setTagFilter: vi.fn(),
	patchNotebook: store.patchNotebook,
	trashNotebook: store.trashNotebook
}));

const recipes = {
	id: 'n1',
	title: 'Recipes',
	pinned: false,
	tags: [],
	card_count: 3,
	updated_at: 1
};

beforeEach(() => {
	vi.clearAllMocks();
	store.list = [recipes];
	renderRowMenuHost();
});

const row = () => screen.getByText('Recipes').closest('button')!;

describe('NotebookList row menu', () => {
	it('renames a notebook in the list', async () => {
		render(NotebookList);
		await pickFromRowMenu(row(), 'Rename');
		const input = screen.getByRole('textbox', { name: 'Notebook title' });
		await fireEvent.input(input, { target: { value: 'Dinners' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(store.patchNotebook).toHaveBeenCalledWith('n1', { title: 'Dinners' });
	});

	it('pins it to the top', async () => {
		render(NotebookList);
		await pickFromRowMenu(row(), 'Pin to top');
		expect(store.patchNotebook).toHaveBeenCalledWith('n1', { pinned: true });
	});

	it('moves it to Trash without asking, since Trash can undo it', async () => {
		render(NotebookList);
		await pickFromRowMenu(row(), 'Move to Trash');
		expect(store.trashNotebook).toHaveBeenCalledWith('n1');
	});
});
