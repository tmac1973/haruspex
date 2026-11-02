<script lang="ts">
	/** The Jobs card: the run going now, the queue, and the latest runs. */
	import type { HomeCardPayload } from '#lib/engine/types.ts';
	import { lastActive } from '#lib/code/sessionList.ts';

	let { payload }: { payload: Extract<HomeCardPayload, { type: 'jobs' }> } = $props();
</script>

{#if payload.current}
	<p>
		<span class="name">{payload.current.jobName}</span>
		<span class="detail">{payload.current.line}</span>
	</p>
{:else}
	<p class="muted">Nothing running.</p>
{/if}
{#if payload.queued > 0}
	<p class="muted">{payload.queued} queued</p>
{/if}
{#if payload.recent.length > 0}
	<ul>
		{#each payload.recent as run, i (i)}
			<li>
				<span class="name">{run.jobName}</span>
				<span class="detail">
					{run.status}{#if run.at}&nbsp;· {lastActive(run.at)}{/if}
				</span>
			</li>
		{/each}
	</ul>
{/if}
