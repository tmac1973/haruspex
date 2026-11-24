<script lang="ts">
	/** Who last changed a card, and when; a click opens what made the change. */
	import { parseSource, type NotebookCard } from '#lib/notebooks/api.ts';
	import { canOpenSource, describeSource, openSource } from '#lib/notebooks/source.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';

	let { card }: { card: NotebookCard } = $props();

	const source = $derived(parseSource(card.source));
	const label = $derived(describeSource(source));
	const when = $derived(new Date(card.updated_at).toLocaleString());

	async function go() {
		if (!(await openSource(source, card.notebook_id))) {
			showToast("That's no longer there.", { kind: 'info' });
		}
	}
</script>

{#if source.kind !== 'user'}
	{#if canOpenSource(source)}
		<button class="badge link" title="{when} — click to open" onclick={() => void go()}>
			{label}
		</button>
	{:else}
		<span class="badge" title={when}>{label}</span>
	{/if}
{/if}

<style>
	.badge {
		flex-shrink: 1;
		min-width: 0;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--accent-soft);
		color: var(--text-secondary);
		font-size: 0.72rem;
		padding: 1px 8px;
	}

	.link {
		cursor: pointer;
	}

	.link:hover {
		color: var(--text-primary);
		border-color: var(--accent);
	}
</style>
