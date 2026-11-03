<script lang="ts">
	/** The Jobs card: the run going now, the queue, and the latest runs. */
	import type { HomeCardPayload } from '#lib/engine/types.ts';
	import { lastActive } from '#lib/code/sessionList.ts';

	let { payload }: { payload: Extract<HomeCardPayload, { type: 'jobs' }> } = $props();
</script>

{#if payload.current}
	<p class="current">
		<span class="name">{payload.current.jobName}</span>
		<span class="detail">{payload.current.line}</span>
	</p>
	{#if payload.current.progress !== null}
		<div class="bar">
			<span style:width="{Math.round(payload.current.progress * 100)}%"></span>
		</div>
	{/if}
{:else}
	<p class="muted">Nothing running.</p>
{/if}
{#if payload.queued > 0}
	<p class="muted"><span class="count">{payload.queued}</span> queued</p>
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

<style>
	.current {
		padding: 4px 6px;
		margin: 4px -6px;
		border-radius: 4px;
		background: var(--accent-soft);
	}

	.current .detail,
	.count {
		color: var(--accent);
	}

	.count {
		font-weight: 600;
	}

	.bar {
		height: 4px;
		margin: 4px 0 6px;
		border-radius: 2px;
		background: var(--border);
		overflow: hidden;
	}

	.bar span {
		display: block;
		height: 100%;
		border-radius: 2px;
		background: var(--accent);
	}
</style>
