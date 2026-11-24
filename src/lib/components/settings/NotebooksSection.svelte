<script lang="ts">
	/**
	 * Settings → Notebooks: semantic search. On downloads the embedding model
	 * Memory uses (once), then indexes notebooks in the background.
	 */
	import { onMount } from 'svelte';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import {
		downloadModel,
		getModelError,
		getModelStatus,
		refreshModelStatus
	} from '#lib/stores/memory.svelte.ts';
	import { getIndexPending, indexNow } from '#lib/notebooks/indexer.svelte.ts';

	let on = $state(getSettings().notebooks.semanticSearch);
	const status = $derived(getModelStatus());
	const error = $derived(getModelError());

	onMount(() => {
		void refreshModelStatus();
		if (on) void indexNow();
	});

	async function toggle(next: boolean) {
		on = next;
		updateSettings({ notebooks: { ...getSettings().notebooks, semanticSearch: next } });
		if (!next) return;
		if (getModelStatus() !== 'ready') await downloadModel();
		void indexNow();
	}
</script>

<section class="settings-section">
	<h2>Search</h2>
	<label
		class="toggle-row"
		title="Finds cards by what they mean, not only the words in them. Downloads the 65 MB model Memory uses, once; notebooks are indexed on this computer."
	>
		<input type="checkbox" checked={on} onchange={(e) => void toggle(e.currentTarget.checked)} />
		<div>
			<strong>Semantic search</strong>
			<span>Find notebook cards by meaning as well as by words.</span>
		</div>
	</label>
	{#if on}
		{#if status === 'downloading'}
			<p class="hint">Downloading the model…</p>
		{:else if status === 'error'}
			<p class="hint error">The model didn't download: {error}</p>
		{:else if getIndexPending() > 0}
			<p class="hint">Indexing {getIndexPending()} cards…</p>
		{/if}
	{/if}
</section>

<style>
	.hint {
		margin: 6px 0 0;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.error {
		color: var(--error-text);
	}
</style>
