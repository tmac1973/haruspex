<script lang="ts">
	/**
	 * The Notebooks tab: the notebook list on the left, the open notebook (or
	 * Trash) in the middle, and the notebook's agent chat on the right.
	 */
	import { onMount } from 'svelte';
	import NotebookList from '#lib/components/notebooks/NotebookList.svelte';
	import NotebookView from '#lib/components/notebooks/NotebookView.svelte';
	import TrashView from '#lib/components/notebooks/TrashView.svelte';
	import {
		getOpenNotebook,
		isNotebookListLoaded,
		isTrashShown,
		loadNotebookList
	} from '#lib/stores/notebooks.svelte.ts';

	onMount(() => {
		if (!isNotebookListLoaded()) void loadNotebookList();
	});

	const open = $derived(getOpenNotebook());
</script>

<div class="notebooks">
	<NotebookList />
	{#if isTrashShown()}
		<TrashView />
	{:else if open}
		<NotebookView notebook={open} />
	{:else}
		<div class="none">
			<p>Pick a notebook, or make one with + New.</p>
		</div>
	{/if}
</div>

<style>
	.notebooks {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.none {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
	}
</style>
