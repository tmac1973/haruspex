<script lang="ts">
	/**
	 * The Notebooks tab: the notebook list on the left, the open notebook (or
	 * Trash) in the middle, and the notebook's agent chat on the right.
	 */
	import { onMount } from 'svelte';
	import NotebookList from '#lib/components/notebooks/NotebookList.svelte';
	import NotebookView from '#lib/components/notebooks/NotebookView.svelte';
	import TrashView from '#lib/components/notebooks/TrashView.svelte';
	import SourceBadge from '#lib/components/notebooks/SourceBadge.svelte';
	import CardHistory from '#lib/components/notebooks/CardHistory.svelte';
	import NotebookChatPanel from '#lib/components/notebooks/NotebookChatPanel.svelte';
	import { persistItem } from '#lib/persist.ts';
	import type { NotebookCard } from '#lib/notebooks/api.ts';
	import { pickFilesAsCards } from '#lib/notebooks/files.ts';
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

	const CHAT_KEY = 'haruspex.notebookChatOpen';
	function chatOpenAtStart(): boolean {
		try {
			return localStorage.getItem(CHAT_KEY) !== 'false';
		} catch {
			return true;
		}
	}
	let chatOpen = $state(chatOpenAtStart());
	function setChatOpen(open: boolean) {
		chatOpen = open;
		try {
			persistItem(CHAT_KEY, String(open));
		} catch {
			// a convenience only
		}
	}

	/** The card whose History is showing. */
	let historyFor = $state<NotebookCard | null>(null);
</script>

<div class="notebooks">
	<NotebookList />
	{#if isTrashShown()}
		<TrashView />
	{:else if open}
		<NotebookView
			notebook={open}
			onpickkind={(kind, after) => {
				if (kind === 'image' || kind === 'attachment') void pickFilesAsCards(kind, after);
			}}
			cardMenu={(card) => [{ label: 'History…', run: () => (historyFor = card) }]}
		>
			{#snippet cardBadge(card)}
				<SourceBadge {card} />
			{/snippet}
		</NotebookView>
		{#if chatOpen}
			<NotebookChatPanel
				notebookId={open.notebook.id}
				title={open.notebook.title}
				onclose={() => setChatOpen(false)}
			/>
		{:else}
			<button class="chat-tab" onclick={() => setChatOpen(true)} title="Ask about this notebook">
				«&nbsp;Ask
			</button>
		{/if}
	{:else}
		<div class="none">
			<p>Pick a notebook, or make one with + New.</p>
		</div>
	{/if}
</div>
{#if historyFor}
	<CardHistory card={historyFor} onclose={() => (historyFor = null)} />
{/if}

<style>
	.notebooks {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.chat-tab {
		align-self: flex-start;
		margin: 12px 8px 0 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px 8px;
		font-size: 0.8rem;
	}

	.none {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
	}
</style>
