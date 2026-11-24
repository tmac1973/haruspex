<script lang="ts">
	/**
	 * The box every notebook card sits in: an editable title, a slot for its
	 * source badge, and a menu to move, add after, or delete it.
	 */
	import type { Snippet } from 'svelte';
	import type { NotebookCard } from '#lib/notebooks/api.ts';
	import { nudgeCard, saveCard, trashCard } from '#lib/stores/notebooks.svelte.ts';

	interface Props {
		card: NotebookCard;
		canMoveUp: boolean;
		canMoveDown: boolean;
		/** Flash once, when the card was just added or linked to. */
		flash?: boolean;
		/** Extra menu items a card kind adds (Export table…, History…). */
		menuItems?: { label: string; run: () => void }[];
		badge?: Snippet;
		children: Snippet;
		/** A drag to reorder starts here. */
		ondragstart?: (e: DragEvent) => void;
	}

	let {
		card,
		canMoveUp,
		canMoveDown,
		flash = false,
		menuItems = [],
		badge,
		children,
		ondragstart
	}: Props = $props();

	let menuOpen = $state(false);
	let title = $derived(card.title);

	function pick(action: () => void) {
		menuOpen = false;
		action();
	}

	function saveTitle() {
		const t = title.trim();
		if (t !== card.title) void saveCard(card, { title: t });
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (menuOpen && e.key === 'Escape') menuOpen = false;
	}}
/>

<section class="card" class:flash id="nb-card-{card.id}" aria-label={card.title || card.kind}>
	<header>
		<span
			class="handle"
			draggable="true"
			{ondragstart}
			role="button"
			tabindex="-1"
			aria-label="Drag to move"
			title="Drag to move"
		>
			⋮⋮
		</span>
		<input
			class="title"
			bind:value={title}
			placeholder="Untitled"
			aria-label="Card title"
			onblur={saveTitle}
			onkeydown={(e) => {
				if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
			}}
		/>
		{#if badge}{@render badge()}{/if}
		<div class="menu-host">
			<button
				class="menu-btn"
				onclick={() => (menuOpen = !menuOpen)}
				aria-label="Card options"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
			>
				⋯
			</button>
			{#if menuOpen}
				<div class="menu" role="menu" aria-label="Card options">
					{#if canMoveUp}
						<button role="menuitem" onclick={() => pick(() => void nudgeCard(card.id, -1))}>
							Move up
						</button>
					{/if}
					{#if canMoveDown}
						<button role="menuitem" onclick={() => pick(() => void nudgeCard(card.id, 1))}>
							Move down
						</button>
					{/if}
					{#each menuItems as item (item.label)}
						<button role="menuitem" onclick={() => pick(item.run)}>{item.label}</button>
					{/each}
					<button role="menuitem" onclick={() => pick(() => void trashCard(card.id))}>
						Delete
					</button>
				</div>
			{/if}
		</div>
	</header>
	<div class="body">
		{@render children()}
	</div>
</section>

<style>
	.card {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
		transition: box-shadow 0.4s;
	}

	.card.flash {
		box-shadow: 0 0 0 2px var(--accent);
	}

	header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 8px 4px;
	}

	.handle {
		color: var(--text-faint);
		cursor: grab;
		font-size: 0.8rem;
		letter-spacing: -2px;
		user-select: none;
	}

	.title {
		flex: 1;
		min-width: 0;
		border: none;
		background: none;
		color: var(--text-primary);
		font-size: 0.95rem;
		font-weight: 600;
		padding: 2px 4px;
		border-radius: 4px;
	}

	.title:focus {
		outline: 1px solid var(--border-strong);
		background: var(--bg-input);
	}

	.menu-host {
		position: relative;
		flex-shrink: 0;
	}

	.menu-btn {
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1rem;
		padding: 2px 6px;
		border-radius: 4px;
	}

	.menu-btn:hover {
		color: var(--text-primary);
		background: var(--bg-primary);
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 10;
		display: flex;
		flex-direction: column;
		min-width: 150px;
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

	.body {
		padding: 0 12px 10px;
	}
</style>
