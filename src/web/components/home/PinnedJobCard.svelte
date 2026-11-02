<script lang="ts">
	/** A pinned job: what its latest successful run produced. */
	import type { HomeCardPayload } from '#lib/engine/types.ts';
	import { renderMarkdown } from '#lib/markdown.ts';
	import { lastActive } from '#lib/code/sessionList.ts';
	import JobStatus from './JobStatus.svelte';

	let { payload }: { payload: Extract<HomeCardPayload, { type: 'pinned_job' }> } = $props();
</script>

{#if !payload.exists}
	<p class="muted">This job was deleted.</p>
{:else}
	<JobStatus state={payload} doing="Running…" />
	{#if payload.output}
		<!-- renderMarkdown sanitises its output. -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		<div class="markdown">{@html renderMarkdown(payload.output)}</div>
		{#if payload.truncated}
			<p class="muted">The rest is on your computer, in the Jobs tab.</p>
		{/if}
		{#if payload.updatedAt}
			<p class="detail">{lastActive(payload.updatedAt)}</p>
		{/if}
	{:else if !payload.running && !payload.queued && !payload.failed}
		<p class="muted">No successful run yet.</p>
	{/if}
{/if}

<style>
	.markdown {
		max-height: 360px;
		overflow-y: auto;
		font-size: 0.88rem;
		overflow-wrap: anywhere;
	}
</style>
