<script lang="ts">
	/**
	 * The band at the top of Home: a greeting and what needs looking at, read
	 * from the same places the cards read. A job or session fact opens its tab.
	 */
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
	import type { MeetingsResult } from '#lib/home/meetings.ts';
	import { greeting, summaryFacts } from '#lib/home/summary.ts';
	import { getLatestRun } from '#lib/home/latestRun.svelte.ts';
	import { sessionsNeedingAttention } from '#lib/home/needsAttention.ts';
	import { getCurrentRun, getQueueDepth } from '#lib/agent/jobs/runner.svelte.ts';
	import { currentPrompts } from '#lib/engine/prompts.svelte.ts';
	import { getOpenSessions } from '#lib/stores/code.svelte.ts';
	import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';

	let { cards }: { cards: HomeCard[] } = $props();

	// The greeting and "now" move on with the clock.
	let now = $state(new Date());
	$effect(() => {
		const timer = setInterval(() => (now = new Date()), 60_000);
		return () => clearInterval(timer);
	});

	function parse<T>(json: string | null | undefined): T | null {
		if (!json) return null;
		try {
			return JSON.parse(json) as T;
		} catch {
			return null;
		}
	}

	const emails = $derived.by(() => {
		const own = cards.filter((c) => c.card_type === 'important_emails' && c.job_id !== null);
		if (own.length === 0) return null;
		return own.reduce((sum, c) => {
			const json = getLatestRun(c.job_id as number).latestSucceeded?.result_json;
			return sum + (parse<{ items: unknown[] }>(json)?.items.length ?? 0);
		}, 0);
	});

	const facts = $derived.by(() => {
		const waiting = sessionsNeedingAttention(currentPrompts('main'));
		return summaryFacts(
			{
				run: getCurrentRun(),
				queued: getQueueDepth(),
				attention: getOpenSessions().filter((s) => waiting.has(s.id)).length,
				emails,
				meetings: cards
					.filter((c) => c.card_type === 'upcoming_meetings')
					.flatMap((c) => parse<MeetingsResult>(c.last_result)?.events ?? [])
			},
			now
		);
	});
</script>

<div class="band">
	<span class="hello">{greeting(now)}</span>
	{#each facts as fact (fact.key)}
		{#if fact.target}
			{@const target = fact.target}
			<button class="fact" onclick={() => setActiveTab(target)}>
				{#if fact.count !== null}<span class="count">{fact.count}</span>{/if}
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
		gap: 6px 18px;
		min-width: 0;
		padding: 10px 14px;
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
	}

	button.fact:hover {
		color: var(--text-primary);
		text-decoration: underline;
	}

	.count {
		color: var(--accent);
		font-weight: 600;
	}
</style>
