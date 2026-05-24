<script lang="ts">
	import { getActiveTab, setActiveTab, type ActiveTab } from '$lib/stores/activeTab.svelte';

	interface Tab {
		id: ActiveTab;
		label: string;
	}

	const tabs: Tab[] = [
		{ id: 'chat', label: 'Chat' },
		{ id: 'jobs', label: 'Jobs' }
	];

	const active = $derived(getActiveTab());
</script>

<div class="tab-bar" role="tablist" aria-label="Main view">
	{#each tabs as tab (tab.id)}
		<button
			role="tab"
			class="tab"
			class:active={active === tab.id}
			aria-selected={active === tab.id}
			tabindex={active === tab.id ? 0 : -1}
			onclick={() => setActiveTab(tab.id)}
		>
			{tab.label}
		</button>
	{/each}
</div>

<style>
	.tab-bar {
		display: flex;
		align-items: stretch;
		gap: 0;
		border-bottom: 1px solid var(--border);
		background: var(--bg-primary);
		flex-shrink: 0;
	}

	.tab {
		appearance: none;
		background: none;
		border: none;
		padding: 8px 16px;
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-secondary);
		cursor: pointer;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		transition:
			color 0.12s,
			border-color 0.12s;
	}

	.tab:hover {
		color: var(--text-primary);
	}

	.tab.active {
		color: var(--text-primary);
		border-bottom-color: var(--accent);
	}
</style>
