/** What a `notebook:` link does when clicked: show the Notebooks tab on it. */
import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';
import { openNotebook } from '#lib/stores/notebooks.svelte.ts';

export async function openNotebookLink(id: string, cardId?: string): Promise<void> {
	setActiveTab('notebooks');
	await openNotebook(id, cardId);
}
