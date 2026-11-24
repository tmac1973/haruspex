<script lang="ts">
	// The notebook refresh job's section of the job editor (see JobTypeEditorProps).
	import Tooltip from '#lib/components/Tooltip.svelte';
	import {
		getNotebookList,
		isNotebookListLoaded,
		loadNotebookList
	} from '#lib/stores/notebooks.svelte.ts';
	import {
		INSTRUCTION_MAX,
		type NotebookRefreshConfig
	} from '#lib/agent/jobs/types/notebook-refresh/config.ts';

	let { config = $bindable() }: { config: Record<string, unknown> } = $props();

	const cfg = config as unknown as NotebookRefreshConfig;

	$effect(() => {
		if (!isNotebookListLoaded()) void loadNotebookList();
	});
</script>

<label class="field">
	<span class="label">
		Notebook
		<Tooltip
			label="About the notebook"
			text="Each run works in this notebook (the Notebooks tab). Its changes show “From Jobs” on the cards, and each card's History can undo them."
		/>
	</span>
	<select bind:value={cfg.notebookId} aria-label="Notebook">
		<option value="">Pick a notebook…</option>
		{#each getNotebookList() as nb (nb.id)}
			<option value={nb.id}>{nb.title}</option>
		{/each}
	</select>
</label>

<label class="field">
	<span class="label">
		What to update
		<Tooltip
			label="About the instruction"
			text="Say which cards or columns to refresh, e.g. “Check each speaker's current price and stock at its retailer and update the Price and In stock columns.” Each run does only this."
		/>
	</span>
	<textarea
		bind:value={cfg.instruction}
		rows="4"
		maxlength={INSTRUCTION_MAX}
		placeholder="Update the prices in the Models table"
		aria-label="What to update"></textarea>
</label>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: 12px;
	}

	.label {
		display: flex;
		align-items: center;
		gap: 4px;
		font-weight: 600;
		font-size: 0.9rem;
	}

	select,
	textarea {
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
	}
</style>
