<script lang="ts" module>
	export interface ItemAction {
		label: string;
		run: () => void;
		/** Shown greyed out, with the reason as its tooltip. */
		disabledReason?: string;
	}
</script>

<script lang="ts">
	/** The ⋯ menu on one row of a Home card: Open, Ask about this, Draft reply. */

	let { actions, label }: { actions: ItemAction[]; label: string } = $props();

	let open = $state(false);

	function pick(action: ItemAction) {
		open = false;
		action.run();
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (open && e.key === 'Escape') open = false;
	}}
/>

<span class="host">
	<button
		class="trigger"
		onclick={() => (open = !open)}
		aria-label={`Actions for ${label}`}
		aria-haspopup="menu"
		aria-expanded={open}>⋯</button
	>
	{#if open}
		<div class="menu" role="menu" aria-label={`Actions for ${label}`}>
			{#each actions as action (action.label)}
				<button
					role="menuitem"
					onclick={() => pick(action)}
					disabled={action.disabledReason !== undefined}
					title={action.disabledReason}>{action.label}</button
				>
			{/each}
		</div>
	{/if}
</span>

<style>
	.host {
		position: relative;
		flex-shrink: 0;
	}

	.trigger {
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 0 4px;
		border-radius: 4px;
	}

	.trigger:hover {
		color: var(--text-primary);
		background: var(--bg-primary);
	}

	.menu {
		position: absolute;
		top: calc(100% + 2px);
		right: 0;
		z-index: 10;
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

	.menu button:hover:not(:disabled) {
		background: var(--bg-primary);
	}

	.menu button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
