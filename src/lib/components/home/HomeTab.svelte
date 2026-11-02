<script lang="ts">
	import { onMount } from 'svelte';
	import CardFrame from '#lib/components/home/CardFrame.svelte';
	import { cardTypes, getCardType, type CardSize } from '#lib/home/cardTypes.ts';
	import {
		addCard,
		getHomeCards,
		isHomeCardsLoaded,
		loadHomeCards,
		moveCard,
		removeCard,
		setCardSize
	} from '#lib/stores/homeCards.svelte.ts';

	const cards = $derived(getHomeCards());
	const addable = $derived(cardTypes().filter((t) => t.addable()));
	let addOpen = $state(false);

	onMount(() => {
		void loadHomeCards();
	});

	function add(typeId: string, size: CardSize) {
		addOpen = false;
		void addCard(typeId, {}, null, size);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (addOpen && e.key === 'Escape') addOpen = false;
	}}
/>

<div class="home">
	<div class="toolbar">
		<div class="add-host">
			<button
				class="add-btn"
				onclick={() => (addOpen = !addOpen)}
				aria-haspopup="menu"
				aria-expanded={addOpen}>Add card</button
			>
			{#if addOpen}
				<div class="menu" role="menu" aria-label="Add card">
					{#each addable as type (type.id)}
						<button role="menuitem" onclick={() => add(type.id, type.defaultSize)}
							>{type.label}</button
						>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	{#if isHomeCardsLoaded() && cards.length === 0}
		<p class="empty">No cards. Add one to see it here.</p>
	{/if}

	<div class="grid">
		{#each cards as card, i (card.id)}
			{@const type = getCardType(card.card_type)}
			<CardFrame
				title={type?.label ?? 'Unknown card'}
				size={card.size === 'wide' ? 'wide' : 'normal'}
				canMoveUp={i > 0}
				canMoveDown={i < cards.length - 1}
				arrangeable={type !== undefined}
				onmove={(dir) => void moveCard(card.id, dir)}
				onresize={(size) => void setCardSize(card.id, size)}
				onremove={() => void removeCard(card.id)}
			>
				{#if type}
					<type.component {card} />
				{:else}
					<p class="muted">This card's type isn't available in this version.</p>
				{/if}
			</CardFrame>
		{/each}
	</div>
</div>

<style>
	.home {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 16px;
	}

	.toolbar {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 12px;
	}

	.add-host {
		position: relative;
	}

	.add-btn {
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
	}

	.add-btn:hover {
		border-color: var(--text-secondary);
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 10;
		display: flex;
		flex-direction: column;
		min-width: 160px;
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

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 12px;
		align-items: start;
	}

	@media (max-width: 700px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}

	.empty,
	.muted {
		color: var(--text-secondary);
	}
</style>
