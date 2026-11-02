<script lang="ts">
	/**
	 * The box every Home card sits in: its title, an optional status line and
	 * "updated" time, and a menu to move, resize or remove it.
	 */
	import type { Snippet } from 'svelte';
	import type { CardSize } from '#lib/home/cardTypes.ts';

	interface Props {
		title: string;
		size: CardSize;
		/** A short line under the title ("2 running"). */
		status?: string | null;
		/** When the card's data was last fetched, for an "updated" line. */
		updatedAt?: number | null;
		/** Move up and Move down are left out where they would do nothing. */
		canMoveUp?: boolean;
		canMoveDown?: boolean;
		/** False for an unknown card type: Remove is all the menu offers. */
		arrangeable?: boolean;
		onmove?: (dir: -1 | 1) => void;
		onresize?: (size: CardSize) => void;
		onremove: () => void;
		children: Snippet;
	}

	let {
		title,
		size,
		status = null,
		updatedAt = null,
		canMoveUp = false,
		canMoveDown = false,
		arrangeable = true,
		onmove,
		onresize,
		onremove,
		children
	}: Props = $props();

	let menuOpen = $state(false);

	function pick(action: () => void) {
		menuOpen = false;
		action();
	}

	function updatedLabel(at: number): string {
		return `Updated ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (menuOpen && e.key === 'Escape') menuOpen = false;
	}}
/>

<section class="card" class:wide={size === 'wide'} aria-label={title}>
	<header>
		<div class="heading">
			<h3>{title}</h3>
			{#if status}
				<span class="status">{status}</span>
			{/if}
		</div>
		<div class="menu-host">
			<button
				class="menu-btn"
				onclick={() => (menuOpen = !menuOpen)}
				aria-label="Card options"
				aria-haspopup="menu"
				aria-expanded={menuOpen}>⋯</button
			>
			{#if menuOpen}
				<div class="menu" role="menu" aria-label="Card options">
					{#if arrangeable && canMoveUp}
						<button role="menuitem" onclick={() => pick(() => onmove?.(-1))}>Move up</button>
					{/if}
					{#if arrangeable && canMoveDown}
						<button role="menuitem" onclick={() => pick(() => onmove?.(1))}>Move down</button>
					{/if}
					{#if arrangeable}
						<button
							role="menuitem"
							onclick={() => pick(() => onresize?.(size === 'wide' ? 'normal' : 'wide'))}
							>{size === 'wide' ? 'Normal width' : 'Wide'}</button
						>
					{/if}
					<button role="menuitem" onclick={() => pick(onremove)}>Remove</button>
				</div>
			{/if}
		</div>
	</header>
	<div class="body">
		{@render children()}
	</div>
	{#if updatedAt}
		<footer>{updatedLabel(updatedAt)}</footer>
	{/if}
</section>

<style>
	.card {
		display: flex;
		flex-direction: column;
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
	}

	.card.wide {
		grid-column: span 2;
	}

	@media (max-width: 700px) {
		.card.wide {
			grid-column: auto;
		}
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 12px 6px;
	}

	.heading {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}

	h3 {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
	}

	.status {
		color: var(--text-secondary);
		font-size: 0.8rem;
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
		line-height: 1;
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
		min-width: 130px;
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
		flex: 1;
		min-height: 0;
		padding: 0 12px 10px;
		font-size: 0.875rem;
	}

	footer {
		padding: 0 12px 8px;
		color: var(--text-secondary);
		font-size: 0.75rem;
	}
</style>
