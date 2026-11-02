<script lang="ts">
	/**
	 * Home, read-only: the desktop's cards in its order, one column. Each card
	 * renders the payload `home.cards` sends; nothing here changes a card.
	 */
	import type { WebStore } from '../../store.svelte.ts';
	import CodeSessionsCard from './CodeSessionsCard.svelte';
	import EmailsCard from './EmailsCard.svelte';
	import JobsCard from './JobsCard.svelte';
	import MeetingsCard from './MeetingsCard.svelte';
	import NewsCard from './NewsCard.svelte';
	import PinnedJobCard from './PinnedJobCard.svelte';
	import WeatherCard from './WeatherCard.svelte';

	let { store }: { store: WebStore } = $props();
</script>

<div class="home">
	{#if store.error}
		<p class="error-text" role="alert">{store.error}</p>
	{/if}
	{#if store.homeCards === null}
		<p class="muted">Reading Home…</p>
	{:else}
		{#each store.homeCards as card (card.id)}
			{@const p = card.payload}
			<section class="home-card" aria-label={card.title}>
				<h3>{card.title}</h3>
				{#if p.type === 'jobs'}
					<JobsCard payload={p} />
				{:else if p.type === 'code_sessions'}
					<CodeSessionsCard {store} />
				{:else if p.type === 'pinned_job'}
					<PinnedJobCard payload={p} />
				{:else if p.type === 'important_emails'}
					<EmailsCard payload={p} />
				{:else if p.type === 'news'}
					<NewsCard payload={p} />
				{:else if p.type === 'upcoming_meetings'}
					<MeetingsCard payload={p} />
				{:else if p.type === 'weather'}
					<WeatherCard payload={p} />
				{/if}
			</section>
		{:else}
			<p class="muted">No cards. Add them on Home on your computer.</p>
		{/each}
	{/if}
</div>

<style>
	.home {
		display: flex;
		flex-direction: column;
		gap: 12px;
		width: 100%;
		max-width: 720px;
		margin: 0 auto;
		padding: 4px 14px 16px;
		box-sizing: border-box;
	}

	.home-card {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
		padding: 10px 12px;
		min-width: 0;
	}

	h3 {
		margin: 0 0 6px;
		font-size: 0.95rem;
		font-weight: 600;
	}

	.home-card :global(ul) {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.home-card :global(p) {
		margin: 4px 0;
	}

	.home-card :global(.muted),
	.muted {
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.home-card :global(.detail) {
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	.home-card :global(.error) {
		color: var(--error-text);
		font-size: 0.85rem;
	}

	.home-card :global(.name) {
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.home-card :global(a) {
		color: var(--accent);
	}
</style>
