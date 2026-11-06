<script lang="ts">
	/** Important emails: what the digest picked, and why. */
	import type { HomeCardPayload } from '#lib/engine/types.ts';
	import { lastActive } from '#lib/code/sessionList.ts';
	import JobStatus from './JobStatus.svelte';

	let { payload }: { payload: Extract<HomeCardPayload, { type: 'important_emails' }> } = $props();

	function when(date: string): string {
		const at = Date.parse(date);
		return Number.isNaN(at) ? '' : lastActive(at);
	}
</script>

{#if payload.accounts}
	<p class="accounts muted" title={payload.accounts}>{payload.accounts}</p>
{/if}
<JobStatus state={payload} doing="Checking your mail…" />
{#if payload.items && payload.items.length > 0}
	<ul>
		{#each payload.items as item, i (i)}
			<li>
				<div class="name">{item.subject || '(no subject)'}</div>
				<div class="detail">{item.from} · {when(item.date)}</div>
				<div class="model">{item.why}</div>
			</li>
		{/each}
	</ul>
{:else if payload.items}
	<p class="muted">No important mail.</p>
{:else if !payload.running && !payload.queued && !payload.failed}
	<p class="muted">Not checked yet.</p>
{/if}
