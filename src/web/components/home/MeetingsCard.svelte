<script lang="ts">
	/** Upcoming meetings. Join opens the call's link in this browser. */
	import type { HomeCardPayload } from '#lib/engine/types.ts';

	let { payload }: { payload: Extract<HomeCardPayload, { type: 'upcoming_meetings' }> } = $props();
</script>

{#if payload.error}
	<p class="error">{payload.error}</p>
{/if}
{#each payload.problems as problem, i (i)}
	<p class="error">{problem}</p>
{/each}
{#if payload.groups === null}
	{#if !payload.error}<p class="muted">Reading your calendars…</p>{/if}
{:else if payload.groups.length === 0}
	<p class="muted">No meetings coming up.</p>
{:else}
	{#each payload.groups as group (group.name)}
		<h4>{group.name}</h4>
		<ul>
			{#each group.events as m, i (i)}
				<li>
					<div class="name">{m.summary || '(no title)'}</div>
					<div class="detail">
						{m.time}{#if m.location}&nbsp;· {m.location}{/if}
						{#if m.joinUrl}
							· <a href={m.joinUrl} target="_blank" rel="noopener noreferrer">Join</a>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/each}
{/if}

<style>
	h4 {
		margin: 8px 0 4px;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary);
	}
</style>
