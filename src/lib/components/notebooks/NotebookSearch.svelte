<script lang="ts">
	/**
	 * The search box over every notebook. Results replace the list while
	 * there's a query; one opens its notebook at the card (and row) it found.
	 */
	import * as api from '#lib/notebooks/api.ts';
	import type { NotebookSearchHit } from '#lib/notebooks/api.ts';
	import { openNotebook } from '#lib/stores/notebooks.svelte.ts';
	import { getSettings } from '#lib/stores/settings.ts';

	interface Props {
		/** Whether results are showing (the list hides meanwhile). */
		active?: boolean;
	}

	let { active = $bindable(false) }: Props = $props();

	let query = $state('');
	let hits = $state<NotebookSearchHit[]>([]);
	let searching = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let seq = 0;

	function onInput() {
		if (timer) clearTimeout(timer);
		const q = query.trim();
		active = q.length > 0;
		if (!q) {
			hits = [];
			return;
		}
		timer = setTimeout(() => void run(q), 300);
	}

	async function run(q: string) {
		const mine = ++seq;
		searching = true;
		try {
			const found = await api.search(q, getSettings().notebooks?.semanticSearch ?? false, 50);
			if (mine === seq) hits = found;
		} catch (e) {
			console.warn('notebook search failed', e);
			if (mine === seq) hits = [];
		} finally {
			if (mine === seq) searching = false;
		}
	}

	/** The snippet with its matches in bold (the database marks them [[ ]]). */
	function parts(snippet: string): { text: string; bold: boolean }[] {
		return snippet
			.split(/(\[\[.*?\]\])/)
			.filter(Boolean)
			.map((p) =>
				p.startsWith('[[') ? { text: p.slice(2, -2), bold: true } : { text: p, bold: false }
			);
	}

	function clear() {
		query = '';
		onInput();
	}
</script>

<div class="search">
	<input
		type="search"
		bind:value={query}
		oninput={onInput}
		onkeydown={(e) => {
			if (e.key === 'Escape') clear();
			if (e.key === 'Enter' && hits[0])
				void openNotebook(
					hits[0].notebook_id,
					hits[0].card_id ?? undefined,
					hits[0].row_id ?? undefined
				);
		}}
		placeholder="Search notebooks"
		aria-label="Search notebooks"
	/>
</div>
{#if active}
	<ul class="hits" aria-label="Search results">
		{#each hits as h, i (i)}
			<li>
				<button
					onclick={() =>
						void openNotebook(h.notebook_id, h.card_id ?? undefined, h.row_id ?? undefined)}
				>
					<span class="where">
						{h.notebook_title}{#if h.card_title}<span class="card"> · {h.card_title}</span>{/if}
					</span>
					<span class="snippet">
						{#each parts(h.snippet) as p, j (j)}{#if p.bold}<b>
									{p.text}
								</b>{:else}{p.text}{/if}{/each}
					</span>
				</button>
			</li>
		{:else}
			<li class="none">{searching ? 'Searching…' : 'Nothing found.'}</li>
		{/each}
	</ul>
{/if}

<style>
	.search {
		padding: 0 12px 8px;
	}

	input {
		width: 100%;
		box-sizing: border-box;
		padding: 5px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
	}

	.hits {
		list-style: none;
		margin: 0;
		padding: 0 6px;
		flex: 1;
		overflow-y: auto;
	}

	.hits button {
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

	.hits button:hover {
		background: var(--bg-primary);
	}

	.where {
		font-size: 0.85rem;
	}

	.card {
		color: var(--text-secondary);
	}

	.snippet {
		color: var(--text-muted);
		font-size: 0.78rem;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.snippet b {
		color: var(--text-primary);
	}

	.none {
		color: var(--text-muted);
		font-size: 0.85rem;
		padding: 8px;
	}
</style>
