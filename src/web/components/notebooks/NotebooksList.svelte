<script lang="ts">
	/** The desktop's notebooks: search, open one, or make one. */
	import type { WebNotebooks } from '../../notebooks.svelte.ts';

	let { nb }: { nb: WebNotebooks } = $props();

	let query = $state('');
	let timer: ReturnType<typeof setTimeout> | null = null;
	let creating = $state(false);
	let title = $state('');

	$effect(() => {
		if (!nb.list) void nb.refreshList();
	});

	function onInput() {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void nb.search(query), 300);
	}

	async function create() {
		const t = title.trim();
		creating = false;
		title = '';
		if (t) await nb.create(t);
	}
</script>

<div class="bar">
	<input
		type="search"
		bind:value={query}
		oninput={onInput}
		placeholder="Search notebooks"
		aria-label="Search notebooks"
	/>
	<button class="new" onclick={() => (creating = !creating)}>+ New</button>
</div>
{#if creating}
	<form
		class="bar"
		onsubmit={(e) => {
			e.preventDefault();
			void create();
		}}
	>
		<input bind:value={title} placeholder="Notebook title" aria-label="New notebook title" />
		<button class="new" type="submit">Make it</button>
	</form>
{/if}
<ul>
	{#if query.trim() && nb.hits}
		{#each nb.hits as h, i (i)}
			<li>
				<button
					onclick={() =>
						void nb.openNotebook(h.notebook_id, h.card_id ?? undefined, h.row_id ?? undefined)}
				>
					<span class="name">{h.notebook_title}{h.card_title ? ` · ${h.card_title}` : ''}</span>
					<span class="meta">{h.snippet.replace(/\[\[|\]\]/g, '')}</span>
				</button>
			</li>
		{:else}
			<li class="none">Nothing found.</li>
		{/each}
	{:else}
		{#each nb.list ?? [] as n (n.id)}
			<li>
				<button
					class:active={nb.open?.notebook.id === n.id}
					onclick={() => void nb.openNotebook(n.id)}
				>
					<span class="name">{n.pinned ? '📌 ' : ''}{n.title}</span>
					<span class="meta">
						{n.card_count} cards{n.tags.length ? ` · ${n.tags.join(', ')}` : ''}
					</span>
				</button>
			</li>
		{:else}
			<li class="none">{nb.list ? 'No notebooks yet.' : 'Loading…'}</li>
		{/each}
	{/if}
</ul>

<style>
	.bar {
		display: flex;
		gap: 6px;
		padding: 8px 10px;
	}

	input {
		flex: 1;
		min-width: 0;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
	}

	.new {
		border: none;
		border-radius: 6px;
		background: var(--accent);
		color: var(--accent-contrast);
		padding: 6px 10px;
		cursor: pointer;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0 6px;
	}

	li button {
		display: flex;
		flex-direction: column;
		width: 100%;
		text-align: left;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-primary);
		padding: 8px;
		cursor: pointer;
	}

	li button.active,
	li button:hover {
		background: var(--bg-primary);
	}

	.meta {
		color: var(--text-muted);
		font-size: 0.8rem;
	}

	.none {
		color: var(--text-muted);
		padding: 8px;
	}
</style>
