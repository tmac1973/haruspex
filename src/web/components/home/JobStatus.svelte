<script lang="ts">
	/** What a card's job is doing now: running, waiting, queued, or failed last time. */
	import type { HomeJobState } from '#lib/engine/types.ts';

	let { state, doing }: { state: HomeJobState; doing: string } = $props();
</script>

{#if state.running}
	<p class="muted">{state.waiting ? 'Waiting for chat…' : doing}</p>
{:else if state.queued}
	<p class="muted">Queued</p>
{/if}
{#if state.failed}
	<p class="error">The last run failed: {state.failed}</p>
{/if}
