<script lang="ts">
	/**
	 * The band at the top of Home, as the desktop has it, from the cards'
	 * payloads and this page's sessions. Job facts need a Jobs card; the
	 * session count opens the Code tab (this page has no Jobs tab).
	 */
	import type { HomeCardView } from '#lib/engine/types.ts';
	import type { WebStore } from '../../store.svelte.ts';
	import { greeting, summaryFacts, type MeetingTimes } from '#lib/home/summary.ts';
	import { sessionsNeedingAttention } from '#lib/home/needsAttention.ts';

	let { store, cards }: { store: WebStore; cards: HomeCardView[] } = $props();

	let now = $state(new Date());
	$effect(() => {
		const timer = setInterval(() => (now = new Date()), 60_000);
		return () => clearInterval(timer);
	});

	const facts = $derived.by(() => {
		const payloads = cards.map((c) => c.payload);
		const jobs = payloads.find((p) => p.type === 'jobs');
		const emails = payloads.filter((p) => p.type === 'important_emails');
		const meetings: MeetingTimes[] = payloads.flatMap((p) =>
			p.type === 'upcoming_meetings' ? (p.groups ?? []).flatMap((g) => g.events) : []
		);
		const waiting = sessionsNeedingAttention(Object.values(store.prompts));
		return summaryFacts(
			{
				run: jobs?.current ?? null,
				queued: jobs?.queued ?? 0,
				attention: store.sessions.filter((s) => waiting.has(s.id)).length,
				emails: emails.length === 0 ? null : emails.reduce((n, p) => n + (p.items?.length ?? 0), 0),
				meetings
			},
			now
		);
	});

	function open() {
		store.tab = 'code';
	}
</script>

<div class="band">
	<span class="hello">{greeting(now)}</span>
	{#each facts as fact (fact.key)}
		{#if fact.target === 'code'}
			<button class="fact" onclick={open}>
				<span class="count">{fact.count}</span>
				{fact.label}
			</button>
		{:else}
			<span class="fact">
				{#if fact.count !== null}<span class="count">{fact.count}</span>{/if}
				{fact.label}
			</span>
		{/if}
	{:else}
		<span class="fact">Nothing needs you.</span>
	{/each}
</div>

<style>
	.band {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 16px;
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
		border-radius: 8px;
		background: var(--accent-soft);
	}

	.hello {
		font-size: 1.05rem;
		font-weight: 600;
	}

	.fact {
		padding: 0;
		border: none;
		background: none;
		color: var(--text-secondary);
		font: inherit;
		font-size: 0.85rem;
	}

	button.fact {
		cursor: pointer;
		text-decoration: underline;
	}

	.count {
		color: var(--accent);
		font-weight: 600;
	}
</style>
