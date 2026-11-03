<script lang="ts">
	/** News: the stories the digest picked. A headline opens its link in this browser. */
	import type { HomeCardPayload } from '#lib/engine/types.ts';
	import { lastActive } from '#lib/code/sessionList.ts';
	import JobStatus from './JobStatus.svelte';

	let { payload }: { payload: Extract<HomeCardPayload, { type: 'news' }> } = $props();
</script>

<JobStatus state={payload} doing="Reading the news…" />
{#if payload.items && payload.items.length > 0}
	<ul>
		{#each payload.items as item, i (i)}
			<li>
				<a class="name" href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a>
				<div class="detail">
					{item.source}{#if item.published}&nbsp;· {lastActive(item.published)}{/if}
				</div>
				<div class="model">{item.summary}</div>
			</li>
		{/each}
	</ul>
{:else if payload.items}
	<p class="muted">Nothing new.</p>
{:else if !payload.running && !payload.queued && !payload.failed}
	<p class="muted">Not read yet.</p>
{/if}
