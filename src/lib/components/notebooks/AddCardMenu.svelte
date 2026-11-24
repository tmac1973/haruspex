<script lang="ts">
	/** "+ Add card": a small menu of card kinds, placed after a card or at the end. */
	import { cardKinds } from '#lib/notebooks/cardKinds.ts';
	import { addCard, getOpenBackend } from '#lib/stores/notebooks.svelte.ts';

	interface Props {
		/** Add after this card; null adds at the end. */
		after: string | null;
		/** A thin line between cards rather than a full button. */
		compact?: boolean;
		/** Kinds that need more than a click (a file picker) handle it here. */
		onpick?: (kind: string, after: string | null) => void;
	}

	let { after, compact = false, onpick }: Props = $props();
	let open = $state(false);

	function pick(kind: string) {
		open = false;
		const def = cardKinds().find((k) => k.kind === kind);
		if (def?.create) void addCard(def.create(), after);
		else onpick?.(kind, after);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (open && e.key === 'Escape') open = false;
	}}
/>

<div class="add" class:compact>
	<button
		class="trigger"
		onclick={() => (open = !open)}
		aria-haspopup="menu"
		aria-expanded={open}
		title="Add a card here"
	>
		{compact ? '+' : '+ Add card'}
	</button>
	{#if open}
		<div class="menu" role="menu" aria-label="Card type">
			{#each cardKinds().filter((k) => getOpenBackend().can.meta || ['text', 'table', 'checklist'].includes(k.kind)) as k (k.kind)}
				<button role="menuitem" onclick={() => pick(k.kind)}>{k.label}</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.add {
		position: relative;
		display: flex;
		justify-content: center;
	}

	.trigger {
		border: 1px dashed var(--border-strong);
		border-radius: 6px;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 6px 14px;
		font-size: 0.85rem;
	}

	.compact .trigger {
		opacity: 0;
		border: none;
		padding: 0 8px;
		font-size: 0.9rem;
		line-height: 1;
	}

	.compact:hover .trigger,
	.compact .trigger:focus-visible,
	.compact .trigger[aria-expanded='true'] {
		opacity: 1;
	}

	.trigger:hover {
		color: var(--accent);
		border-color: var(--accent);
	}

	.menu {
		position: absolute;
		top: calc(100% + 2px);
		z-index: 20;
		display: flex;
		flex-direction: column;
		min-width: 140px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		overflow: hidden;
	}

	.menu button {
		text-align: left;
		padding: 6px 10px;
		border: none;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
	}

	.menu button + button {
		border-top: 1px solid var(--border);
	}

	.menu button:hover {
		background: var(--bg-primary);
	}
</style>
