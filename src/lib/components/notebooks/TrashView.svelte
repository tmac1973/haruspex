<script lang="ts">
	/** Deleted notebooks and cards: restore them, or delete them for good. Kept 30 days. */
	import {
		getTrash,
		purgeCardForGood,
		purgeNotebookForGood,
		restoreCardFromTrash,
		restoreNotebookFromTrash
	} from '#lib/stores/notebooks.svelte.ts';

	const trash = $derived(getTrash());

	function cardLabel(title: string, kind: string): string {
		return title || `Untitled ${kind} card`;
	}

	function forever(what: string, run: () => void) {
		if (confirm(`Delete ${what} for good? This can't be undone.`)) run();
	}
</script>

<div class="trash">
	<h2>Trash</h2>
	<p class="hint">Deleted notebooks and cards are kept here for 30 days.</p>
	{#if trash.notebooks.length === 0 && trash.cards.length === 0}
		<p class="empty">Trash is empty.</p>
	{/if}
	{#if trash.notebooks.length > 0}
		<h3>Notebooks</h3>
		<ul>
			{#each trash.notebooks as nb (nb.id)}
				<li>
					<span class="name">{nb.title}</span>
					<button onclick={() => void restoreNotebookFromTrash(nb.id)}>Restore</button>
					<button
						class="danger"
						onclick={() => forever(`“${nb.title}”`, () => void purgeNotebookForGood(nb.id))}
					>
						Delete forever
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if trash.cards.length > 0}
		<h3>Cards</h3>
		<ul>
			{#each trash.cards as t (t.card.id)}
				<li>
					<span class="name">
						{cardLabel(t.card.title, t.card.kind)} <span class="from">in {t.notebook_title}</span>
					</span>
					<button onclick={() => void restoreCardFromTrash(t.card.id)}>Restore</button>
					<button
						class="danger"
						onclick={() => forever('this card', () => void purgeCardForGood(t.card.id))}
					>
						Delete forever
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.trash {
		flex: 1;
		overflow-y: auto;
		padding: 16px 24px;
		max-width: 760px;
	}

	h2 {
		margin: 0 0 4px;
	}

	h3 {
		margin: 16px 0 6px;
		font-size: 0.95rem;
	}

	.hint,
	.empty {
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
	}

	.name {
		flex: 1;
		min-width: 0;
	}

	.from {
		color: var(--text-muted);
		font-size: 0.8rem;
	}

	button {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-raised);
		color: var(--text-primary);
		cursor: pointer;
		padding: 3px 10px;
		font-size: 0.8rem;
	}

	.danger:hover {
		border-color: var(--error-text);
		color: var(--error-text);
	}
</style>
