<script lang="ts">
	/** Who last changed a card, and when; a click opens what made the change. */
	import { parseSource, type NotebookCard } from '#lib/notebooks/api.ts';
	import { canOpenSource, describeSource, openSource } from '#lib/notebooks/source.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { getConversations } from '#lib/stores/chat.svelte.ts';

	let { card }: { card: NotebookCard } = $props();

	const source = $derived(parseSource(card.source));
	// A chat is named after its first reply, so the label stored with an
	// early change is its opening words; show its name now when it still exists.
	const label = $derived.by(() => {
		if (source.kind === 'chat' && source.ref) {
			const now = getConversations().find((c) => c.id === source.ref)?.title;
			if (now) return describeSource({ ...source, label: now });
		}
		return describeSource(source);
	});
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
