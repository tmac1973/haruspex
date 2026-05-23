<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import GeneralSection from '$lib/components/settings/GeneralSection.svelte';
	import InferenceSection from '$lib/components/settings/InferenceSection.svelte';
	import AgentSection from '$lib/components/settings/AgentSection.svelte';
	import AudioSection from '$lib/components/settings/AudioSection.svelte';
	import SearchSection from '$lib/components/settings/SearchSection.svelte';
	import EmailSection from '$lib/components/settings/EmailSection.svelte';

	type Category = 'general' | 'inference' | 'agent' | 'audio' | 'search' | 'integrations';

	interface CategoryDef {
		id: Category;
		label: string;
	}

	const categories: CategoryDef[] = [
		{ id: 'general', label: 'General' },
		{ id: 'inference', label: 'Inference' },
		{ id: 'agent', label: 'Agent' },
		{ id: 'audio', label: 'Audio' },
		{ id: 'search', label: 'Search' },
		{ id: 'integrations', label: 'Integrations' }
	];

	const STORAGE_KEY = 'haruspex-settings-category';

	let activeCategory = $state<Category>('general');

	onMount(() => {
		try {
			const saved = localStorage.getItem(STORAGE_KEY) as Category | null;
			if (saved && categories.some((c) => c.id === saved)) {
				activeCategory = saved;
			}
		} catch {
			// localStorage may be unavailable in some webviews
		}
	});

	function selectCategory(id: Category) {
		activeCategory = id;
		try {
			localStorage.setItem(STORAGE_KEY, id);
		} catch {
			// ignore
		}
	}

	const activeLabel = $derived(
		categories.find((c) => c.id === activeCategory)?.label ?? 'Settings'
	);
</script>

<div class="settings-header">
	<button class="back-btn" onclick={() => goto('/')}>&#8592; Back</button>
	<h1>Settings</h1>
</div>

<div class="settings-layout">
	<nav class="rail" aria-label="Settings categories">
		{#each categories as cat (cat.id)}
			<button
				class="rail-item"
				class:active={activeCategory === cat.id}
				onclick={() => selectCategory(cat.id)}
			>
				{cat.label}
			</button>
		{/each}
	</nav>

	<div class="pane">
		<h2 class="pane-title">{activeLabel}</h2>
		<div class="pane-content">
			{#if activeCategory === 'general'}
				<GeneralSection />
			{:else if activeCategory === 'inference'}
				<InferenceSection />
			{:else if activeCategory === 'agent'}
				<AgentSection />
			{:else if activeCategory === 'audio'}
				<AudioSection />
			{:else if activeCategory === 'search'}
				<SearchSection />
			{:else if activeCategory === 'integrations'}
				<EmailSection />
			{/if}
		</div>
	</div>
</div>

<style>
	.settings-header {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 12px 24px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-primary);
		position: sticky;
		top: 0;
		z-index: 10;
	}

	.settings-header h1 {
		margin: 0;
		font-size: 1.3rem;
	}

	.back-btn {
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 6px 12px;
		cursor: pointer;
		color: var(--text-primary);
		font-size: 0.9rem;
	}

	.back-btn:hover {
		background: var(--bg-secondary);
	}

	.settings-layout {
		display: flex;
		gap: 24px;
		height: calc(100vh - 45px - 50px);
		align-items: stretch;
	}

	.rail {
		flex: 0 0 200px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 16px 8px 24px 16px;
		border-right: 1px solid var(--border);
		overflow-y: auto;
	}

	.rail-item {
		text-align: left;
		padding: 8px 12px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: none;
		color: var(--text-primary);
		font-size: 0.9rem;
		cursor: pointer;
	}

	.rail-item:hover {
		background: var(--bg-secondary);
	}

	.rail-item.active {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--accent);
		font-weight: 500;
	}

	.pane {
		flex: 1 1 auto;
		min-width: 0;
		overflow-y: auto;
		padding: 0 24px 64px;
	}

	.pane-title {
		font-size: 1.15rem;
		margin: 18px 0 16px 0;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--border);
		color: var(--text-primary);
	}

	.pane-content {
		max-width: 640px;
	}
</style>
