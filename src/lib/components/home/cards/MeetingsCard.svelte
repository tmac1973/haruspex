<script lang="ts">
	/** Home's Upcoming meetings card: the next few hours of the user's calendars. */
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
	import {
		DEFAULT_MEETING_HOURS,
		groupOf,
		type Meeting,
		type MeetingGroup,
		type MeetingsResult
	} from '#lib/home/meetings.ts';
	import { getCardError } from '#lib/home/fetchedCards.svelte.ts';
	import { openInBrowser } from '#lib/utils/openInBrowser.ts';

	let { card }: { card: HomeCard } = $props();

	const result = $derived.by((): MeetingsResult | null => {
		try {
			return card.last_result ? (JSON.parse(card.last_result) as MeetingsResult) : null;
		} catch {
			return null;
		}
	});
	const hours = $derived.by(() => {
		try {
			return (JSON.parse(card.config) as { hours?: number }).hours ?? DEFAULT_MEETING_HOURS;
		} catch {
			return DEFAULT_MEETING_HOURS;
		}
	});
	const error = $derived(getCardError(card.id));

	const ORDER: MeetingGroup[] = ['Now', 'Later today', 'Tomorrow', 'Later'];
	const groups = $derived.by(() => {
		const now = new Date();
		const by: Partial<Record<MeetingGroup, Meeting[]>> = {};
		for (const m of result?.events ?? []) (by[groupOf(m, now)] ??= []).push(m);
		return ORDER.filter((g) => by[g]).map((g) => ({ name: g, events: by[g]! }));
	});

	function time(m: Meeting): string {
		if (m.allDay) return 'All day';
		const fmt = (s: string) =>
			new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		return `${fmt(m.start)}–${fmt(m.end)}`;
	}
</script>

{#if error}
	<p class="error" title={error}>{error}</p>
{/if}
{#if result}
	{#each result.problems as problem (problem)}
		<p class="error" title={problem}>{problem}</p>
	{/each}
	{#if groups.length === 0}
		<p class="muted">Nothing in the next {hours} hours.</p>
	{/if}
	{#each groups as group (group.name)}
		<h4>{group.name}</h4>
		<ul>
			{#each group.events as m (m.uid + m.start)}
				<li>
					<div class="text">
						<span class="title">{m.summary || '(no title)'}</span>
						<span class="when">{time(m)}{m.location && !m.joinUrl ? ` · ${m.location}` : ''}</span>
					</div>
					{#if m.joinUrl}
						<button class="join" onclick={() => void openInBrowser(m.joinUrl!)} title={m.joinUrl}
							>Join</button
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/each}
{:else if !error}
	<p class="muted">Reading your calendar…</p>
{/if}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	h4 {
		margin: 8px 0 4px;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 3px 0;
	}

	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.title,
	.when {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.when,
	.muted {
		color: var(--text-secondary);
	}

	.when {
		font-size: 0.78rem;
	}

	.join {
		flex-shrink: 0;
		padding: 3px 10px;
		border: 1px solid var(--accent);
		border-radius: 6px;
		background: none;
		color: var(--accent);
		cursor: pointer;
		font-size: 0.78rem;
	}

	.muted,
	.error {
		margin: 4px 0;
	}

	.error {
		color: var(--error-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
