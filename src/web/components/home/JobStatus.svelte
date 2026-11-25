<script lang="ts">
	/** What a card's job is doing now: running, waiting, queued, or failed last time. */
	import type { HomeJobState } from '#lib/engine/types.ts';
	import { CARD_JOB_WAIT_TIP } from '#lib/home/jobsCard.ts';

	let { state, doing }: { state: HomeJobState; doing: string } = $props();
</script>

{#if state.running}
	<p class="muted" title={state.waiting ? CARD_JOB_WAIT_TIP : undefined}>
		{state.waiting ? 'Waiting for model…' : doing}
	</p>
{:else if state.queued}
	<p class="muted">Queued</p>
{/if}
{#if state.failed}
	<p class="error">The last run failed: {state.failed}</p>
{/if}
