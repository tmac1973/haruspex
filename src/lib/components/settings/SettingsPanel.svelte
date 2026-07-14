<script lang="ts">
	import { onMount } from 'svelte';
	import GeneralSection from '$lib/components/settings/GeneralSection.svelte';
	import InferenceSection from '$lib/components/settings/InferenceSection.svelte';
	import AgentSection from '$lib/components/settings/AgentSection.svelte';
	import AudioSection from '$lib/components/settings/AudioSection.svelte';
	import SearchSection from '$lib/components/settings/SearchSection.svelte';
	import EmailSection from '$lib/components/settings/EmailSection.svelte';
	import ShellSection from '$lib/components/settings/ShellSection.svelte';
	import FeedbackSection from '$lib/components/settings/FeedbackSection.svelte';

	// Rendered as an overlay over the main page (so the Shell tab's PTY stays
	// mounted underneath). `onclose` dismisses the overlay; the page never
	// navigates away.
	let { onclose }: { onclose: () => void } = $props();

	type Category =
		| 'general'
		| 'inference'
		| 'agent'
		| 'audio'
		| 'search'
		| 'integrations'
		| 'shell'
		| 'feedback';

	interface CategoryDef {
		id: Category;
		label: string;
		subtitle: string;
		/** 15×15 feather-style icon, stroke = currentColor. */
		icon: string;
	}

	interface CategoryGroup {
		label: string;
		items: CategoryDef[];
	}

	const groups: CategoryGroup[] = [
		{
			label: 'Core',
			items: [
				{
					id: 'general',
					label: 'General',
					subtitle: 'Appearance and how replies are formatted.',
					icon: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>'
				},
				{
					id: 'inference',
					label: 'Inference',
					subtitle: 'Where inference runs and how big the context is.',
					icon: '<rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line>'
				},
				{
					id: 'agent',
					label: 'Agent',
					subtitle: 'How the model reasons, remembers, and runs code.',
					icon: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>'
				}
			]
		},
		{
			label: 'Capabilities',
			items: [
				{
					id: 'audio',
					label: 'Audio',
					subtitle: 'Voice input and spoken replies.',
					icon: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>'
				},
				{
					id: 'search',
					label: 'Search',
					subtitle: 'Which provider answers web queries.',
					icon: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>'
				},
				{
					id: 'integrations',
					label: 'Integrations',
					subtitle: 'Read-only email over IMAP.',
					icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline>'
				},
				{
					id: 'shell',
					label: 'Shell',
					subtitle: 'Terminal and the shell assistant.',
					icon: '<polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line>'
				}
			]
		},
		{
			label: 'About',
			items: [
				{
					id: 'feedback',
					label: 'Feedback',
					subtitle: 'Report a bug or request a feature.',
					icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>'
				}
			]
		}
	];

	const categories = groups.flatMap((g) => g.items);

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

	const activeDef = $derived(categories.find((c) => c.id === activeCategory));
</script>

<div class="settings-header">
	<button class="back-btn" onclick={onclose}>&#8592; Back</button>
	<h1>Settings</h1>
</div>

<div class="settings-layout">
	<nav class="rail thin-scroll" aria-label="Settings categories">
		{#each groups as group (group.label)}
			<span class="group-label">{group.label}</span>
			{#each group.items as cat (cat.id)}
				<button
					class="rail-item"
					class:active={activeCategory === cat.id}
					onclick={() => selectCategory(cat.id)}
				>
					<svg
						width="15"
						height="15"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- static icon paths defined above, no user content -->
						{@html cat.icon}
					</svg>
					{cat.label}
				</button>
			{/each}
		{/each}
	</nav>

	<div class="pane">
		<h2 class="pane-title">{activeDef?.label ?? 'Settings'}</h2>
		<p class="pane-subtitle">{activeDef?.subtitle ?? ''}</p>
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
			{:else if activeCategory === 'shell'}
				<ShellSection />
			{:else if activeCategory === 'feedback'}
				<FeedbackSection />
			{/if}
		</div>
	</div>
</div>

<style>
	.settings-header {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 12px 20px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-primary);
		position: sticky;
		top: 0;
		z-index: 10;
	}

	.settings-header h1 {
		margin: 0;
		font-size: 1.2rem;
		font-weight: 600;
	}

	.back-btn {
		background: var(--bg-input);
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		padding: 6px 13px;
		cursor: pointer;
		color: var(--text-primary);
		font-size: 0.85rem;
	}

	.back-btn:hover {
		background: var(--bg-secondary);
	}

	.settings-layout {
		display: flex;
		height: calc(100vh - 45px - 50px);
		align-items: stretch;
	}

	.rail {
		flex: 0 0 190px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 14px 10px 24px;
		border-right: 1px solid var(--border);
		background: var(--bg-secondary);
		overflow-y: auto;
	}

	.group-label {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-faint);
		padding: 4px 8px;
	}

	.group-label:not(:first-child) {
		margin-top: 10px;
	}

	.rail-item {
		display: flex;
		align-items: center;
		gap: 9px;
		text-align: left;
		padding: 8px 11px;
		border: none;
		border-radius: 7px;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.85rem;
		cursor: pointer;
	}

	.rail-item svg {
		flex: none;
	}

	.rail-item:hover {
		background: var(--bg-raised);
		color: var(--text-primary);
	}

	.rail-item.active {
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 500;
	}

	.pane {
		flex: 1 1 auto;
		min-width: 0;
		overflow-y: auto;
		padding: 18px 26px 60px;
	}

	.pane-title {
		font-size: 1.15rem;
		font-weight: 600;
		margin: 0 0 4px 0;
		color: var(--text-primary);
	}

	.pane-subtitle {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin: 0 0 18px 0;
	}

	.pane-content {
		max-width: 640px;
	}
</style>
