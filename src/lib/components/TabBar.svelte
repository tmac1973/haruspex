<script lang="ts">
	import { getActiveTab, setActiveTab, type ActiveTab } from '$lib/stores/activeTab.svelte';
	import { getCurrentRun, getQueueDepth } from '$lib/agent/jobs/runner.svelte';

	interface Tab {
		id: ActiveTab;
		label: string;
	}

	const tabs: Tab[] = [
		{ id: 'chat', label: 'Chat' },
		{ id: 'jobs', label: 'Jobs' }
	];

	const active = $derived(getActiveTab());

	// Surface a small badge on the Jobs tab when work is in flight so
	// users in the Chat tab still see queue depth at a glance.
	const jobsBadge = $derived.by(() => {
		const running = getCurrentRun()?.status === 'running';
		const queued = getQueueDepth();
		if (!running && queued === 0) return null;
		if (running && queued > 0) return `${queued + 1}`;
		if (running) return '●';
		return `${queued}`;
	});
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
			{#if tab.id === 'jobs' && jobsBadge !== null}
				<span class="badge" title="Jobs running or queued">{jobsBadge}</span>
			{/if}
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

	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		margin-left: 6px;
		border-radius: 999px;
		background: var(--accent);
		color: white;
		font-size: 0.66rem;
		font-weight: 600;
		line-height: 1;
		vertical-align: middle;
	}
</style>
