<script lang="ts">
	/** Email requests: what research by email has seen, and each request's state. */
	import type { HomeCardPayload } from '#lib/engine/types.ts';
	import { lastActive } from '#lib/code/sessionList.ts';
	import JobStatus from './JobStatus.svelte';

	let { payload }: { payload: Extract<HomeCardPayload, { type: 'email_requests' }> } = $props();
</script>

{#if payload.setup}
	<p class="muted">{payload.setup}</p>
{/if}
<JobStatus state={payload} doing="Checking for requests…" />
{#if payload.requests && payload.requests.length > 0}
	<ul>
		{#each payload.requests as r, i (i)}
			<li>
				<div class="name">{r.subject}</div>
				<div class="detail">
					{r.state}{r.reason ? ` · ${r.reason}` : ''} · {lastActive(r.at)}
				</div>
				{#if r.auth}<div class="detail">{r.auth}</div>{/if}
			</li>
		{/each}
	</ul>
{:else if payload.requests}
	<p class="muted">No requests yet.</p>
{/if}
