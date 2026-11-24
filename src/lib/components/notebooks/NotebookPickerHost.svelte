<script lang="ts">
	/**
	 * Draws the notebook picker (`#lib/notebooks/notebookPicker.svelte.ts`):
	 * a filter box, the notebooks with the last one picked first, and "New
	 * notebook…". Mounted once in the root layout.
	 */
	import * as api from '#lib/notebooks/api.ts';
	import type { NotebookSummary } from '#lib/notebooks/api.ts';
	import { answerPicker, getLastPicked, getPicker } from '#lib/notebooks/notebookPicker.svelte.ts';
	import { loadNotebookList } from '#lib/stores/notebooks.svelte.ts';
	import { focusOnMount } from '#lib/utils/focusOnMount.ts';

	const picker = $derived(getPicker());
	let list = $state<NotebookSummary[]>([]);
	let filter = $state('');
	let naming = $state(false);
	let newTitle = $state('');

	$effect(() => {
		if (!picker) return;
		filter = '';
		naming = false;
		newTitle = '';
		void api
			.listNotebooks()
			.then((l) => (list = l))
			.catch((e) => console.warn('notebook picker: list failed', e));
	});

	const shown = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		const last = getLastPicked();
		const l = list.filter((n) => !q || n.title.toLowerCase().includes(q));
		return [...l.filter((n) => n.id === last), ...l.filter((n) => n.id !== last)].slice(0, 12);
	});

	/** Keep the popover inside the window. */
	const pos = $derived.by(() => {
		if (!picker) return '';
		const x = Math.min(picker.x, window.innerWidth - 280);
		const y = Math.min(picker.y + 4, window.innerHeight - 360);
		return `left:${Math.max(8, x)}px;top:${Math.max(8, y)}px`;
	});

	async function create() {
		const t = newTitle.trim();
		if (!t) return;
		try {
			const nb = await api.createNotebook(t);
			void loadNotebookList();
			answerPicker(nb.id);
		} catch (e) {
			console.warn('notebook picker: create failed', e);
			answerPicker(null);
		}
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (picker && e.key === 'Escape') answerPicker(null);
	}}
/>

{#if picker}
	<div class="backdrop" role="presentation" onclick={() => answerPicker(null)}></div>
	<div class="picker" style={pos} role="dialog" aria-label={picker.title}>
		<p class="title">{picker.title}</p>
		{#if naming}
			<input
				use:focusOnMount
				bind:value={newTitle}
				placeholder="Notebook title"
				aria-label="New notebook title"
				onkeydown={(e) => {
					if (e.key === 'Enter') void create();
				}}
			/>
			<div class="row">
				<button class="primary" onclick={() => void create()}>Make it</button>
				<button onclick={() => (naming = false)}>Back</button>
			</div>
		{:else}
			<input
				use:focusOnMount
				bind:value={filter}
				placeholder="Find a notebook"
				aria-label="Find a notebook"
				onkeydown={(e) => {
					if (e.key === 'Enter' && shown[0]) answerPicker(shown[0].id);
				}}
			/>
			<ul>
				{#each shown as nb (nb.id)}
					<li><button onclick={() => answerPicker(nb.id)}>{nb.title}</button></li>
				{:else}
					<li class="none">No notebooks{filter ? ' match' : ' yet'}.</li>
				{/each}
			</ul>
			{#if picker.mode === 'add'}
				<button class="new" onclick={() => (naming = true)}>+ New notebook…</button>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 200;
	}

	.picker {
		position: fixed;
		z-index: 201;
		width: 260px;
		max-height: 340px;
		display: flex;
		flex-direction: column;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
		box-shadow: 0 6px 24px rgb(0 0 0 / 25%);
	}

	.title {
		margin: 0 0 6px;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	input {
		padding: 5px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
	}

	ul {
		list-style: none;
		margin: 6px 0;
		padding: 0;
		overflow-y: auto;
	}

	li button,
	.new {
		width: 100%;
		text-align: left;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		padding: 5px 8px;
		font-size: 0.85rem;
	}

	li button:hover,
	.new:hover {
		background: var(--bg-primary);
	}

	.new {
		color: var(--accent);
	}

	.none {
		color: var(--text-muted);
		font-size: 0.82rem;
		padding: 4px 8px;
	}

	.row {
		display: flex;
		gap: 6px;
		margin-top: 6px;
	}

	.row button {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-raised);
		color: var(--text-primary);
		cursor: pointer;
		padding: 4px 10px;
	}

	.row .primary {
		border: none;
		background: var(--accent);
		color: var(--accent-contrast);
	}
</style>
