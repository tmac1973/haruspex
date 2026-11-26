<script lang="ts">
	/**
	 * The notebook list: pinned first, then by last edit, with tag chips to
	 * filter, a New button, and Trash at the bottom. Right-click a notebook
	 * (or double-click it) to rename it; the menu also pins it or moves it to
	 * Trash.
	 */
	import type { Snippet } from 'svelte';
	import { focusOnMount } from '#lib/utils/focusOnMount.ts';
	import NotebookSearch from '#lib/components/notebooks/NotebookSearch.svelte';
	import {
		allTags,
		getNotebookList,
		getOpenNotebookId,
		getTagFilter,
		isTrashShown,
		newNotebook,
		openNotebook,
		openTrash,
		patchNotebook,
		setTagFilter,
		trashNotebook
	} from '#lib/stores/notebooks.svelte.ts';
	import type { NotebookSummary } from '#lib/notebooks/api.ts';
	import { rowMenu } from '#lib/actions/rowMenu.ts';
	import type { RowMenuItem } from '#lib/stores/rowMenu.svelte.ts';

	interface Props {
		/** Above the list: the search box. */
		top?: Snippet;
		/** Below "This computer": other computers' notebooks. */
		more?: Snippet;
		/** "Import…": Markdown, CSV or spreadsheet files as new notebooks. */
		onimport?: () => void;
	}

	let { top, more, onimport }: Props = $props();

	let searching = $state(false);
	let creating = $state(false);
	let newTitle = $state('');

	const filter = $derived(getTagFilter());
	const notebooks = $derived(
		getNotebookList().filter((n) => filter === null || n.tags.includes(filter))
	);

	let renamingId = $state<string | null>(null);
	let renameText = $state('');

	function startRename(nb: NotebookSummary): void {
		renamingId = nb.id;
		renameText = nb.title;
	}

	function finishRename(): void {
		const id = renamingId;
		const title = renameText.trim();
		renamingId = null;
		const nb = notebooks.find((n) => n.id === id);
		if (id && nb && title && title !== nb.title) void patchNotebook(id, { title });
	}

	function menuItems(nb: NotebookSummary): RowMenuItem[] {
		return [
			{ label: 'Rename', run: () => startRename(nb) },
			{
				label: nb.pinned ? 'Unpin' : 'Pin to top',
				run: () => void patchNotebook(nb.id, { pinned: !nb.pinned })
			},
			{
				label: 'Move to Trash',
				danger: true,
				title: 'Kept in Trash for 30 days',
				run: () => void trashNotebook(nb.id)
			}
		];
	}

	async function create() {
		const t = newTitle.trim();
		if (!t) {
			creating = false;
			return;
		}
		creating = false;
		newTitle = '';
		await newNotebook(t, filter ? [filter] : []);
	}

	function ago(ms: number): string {
		const d = new Date(ms);
		const today = new Date();
		return d.toDateString() === today.toDateString()
			? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
			: d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
</script>

<aside class="list">
	<div class="head">
		<h2>Notebooks</h2>
		<button class="new" onclick={() => (creating = true)} title="New notebook">+ New</button>
	</div>
	{#if creating}
		<input
			class="new-title"
			use:focusOnMount
			bind:value={newTitle}
			placeholder="Notebook title"
			aria-label="New notebook title"
			onblur={() => void create()}
			onkeydown={(e) => {
				if (e.key === 'Enter') void create();
				if (e.key === 'Escape') {
					creating = false;
					newTitle = '';
				}
			}}
		/>
	{/if}
	{#if top}{@render top()}{/if}
	<NotebookSearch bind:active={searching} />
	{#if !searching && allTags().length > 0}
		<div class="tags" role="group" aria-label="Filter by tag">
			{#each allTags() as tag (tag)}
				<button
					class="chip"
					class:on={filter === tag}
					aria-pressed={filter === tag}
					onclick={() => setTagFilter(filter === tag ? null : tag)}
				>
					{tag}
				</button>
			{/each}
		</div>
	{/if}
	<ul class:hidden={searching}>
		{#each notebooks as nb (nb.id)}
			<li>
				{#if renamingId === nb.id}
					<input
						class="rename"
						use:focusOnMount
						onfocus={(e) => e.currentTarget.select()}
						bind:value={renameText}
						aria-label="Notebook title"
						onblur={finishRename}
						onkeydown={(e) => {
							if (e.key === 'Enter') finishRename();
							if (e.key === 'Escape') renamingId = null;
						}}
					/>
				{:else}
					<button
						class="item"
						class:active={getOpenNotebookId() === nb.id}
						title="{nb.title} — right-click to rename, pin or delete"
						onclick={() => void openNotebook(nb.id)}
						ondblclick={() => startRename(nb)}
						use:rowMenu={() => menuItems(nb)}
					>
						<span class="name">
							{#if nb.pinned}<span class="pin" aria-label="Pinned">📌</span>{/if}{nb.title}
						</span>
						<span class="meta">
							{nb.card_count}
							{nb.card_count === 1 ? 'card' : 'cards'} · {ago(nb.updated_at)}
						</span>
					</button>
				{/if}
			</li>
		{:else}
			<li class="empty">
				{filter ? 'No notebooks with this tag.' : 'No notebooks yet.'}
			</li>
		{/each}
	</ul>
	{#if more}{@render more()}{/if}
	{#if onimport}
		<button
			class="trash"
			onclick={onimport}
			title="Make notebooks from Markdown, CSV or spreadsheet files"
		>
			⤓ Import…
		</button>
	{/if}
	<button class="trash" class:active={isTrashShown()} onclick={() => void openTrash()}>
		🗑 Trash
	</button>
</aside>

<style>
	.list {
		display: flex;
		flex-direction: column;
		width: 250px;
		flex-shrink: 0;
		border-right: 1px solid var(--border);
		background: var(--bg-secondary);
		overflow-y: auto;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 12px 8px;
	}

	h2 {
		margin: 0;
		font-size: 1rem;
	}

	.new {
		border: none;
		border-radius: 6px;
		background: var(--accent);
		color: var(--accent-contrast);
		cursor: pointer;
		padding: 4px 10px;
		font-size: 0.8rem;
	}

	.rename {
		width: 100%;
		box-sizing: border-box;
		margin: 2px 0;
		padding: 6px 8px;
		border: 1px solid var(--accent);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.85rem;
	}

	.new-title {
		margin: 0 12px 8px;
		padding: 6px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 0 12px 8px;
	}

	.chip {
		border: 1px solid var(--border);
		border-radius: 12px;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 1px 8px;
		font-size: 0.75rem;
	}

	.chip.on {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text-primary);
	}

	ul.hidden {
		display: none;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0 6px;
		flex: 1;
	}

	.item {
		display: flex;
		flex-direction: column;
		width: 100%;
		text-align: left;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		padding: 6px 8px;
	}

	.item:hover {
		background: var(--bg-primary);
	}

	.item.active {
		background: var(--accent-soft);
	}

	.name {
		font-size: 0.9rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.pin {
		font-size: 0.7rem;
		margin-right: 4px;
	}

	.meta {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.empty {
		color: var(--text-muted);
		font-size: 0.85rem;
		padding: 8px;
	}

	.trash {
		margin: 8px 6px 10px;
		text-align: left;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 6px 8px;
		font-size: 0.85rem;
	}

	.trash:hover,
	.trash.active {
		background: var(--bg-primary);
	}
</style>
