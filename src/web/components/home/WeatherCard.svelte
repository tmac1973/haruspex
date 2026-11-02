<script lang="ts">
	/** Weather: now, today and tomorrow for the card's place. */
	import type { HomeCardPayload } from '#lib/engine/types.ts';

	let { payload }: { payload: Extract<HomeCardPayload, { type: 'weather' }> } = $props();
</script>

{#if payload.place}
	<p class="detail">{payload.place}</p>
{/if}
{#if payload.error}
	<p class="error">{payload.error}</p>
{/if}
{#if payload.now}
	<p class="now">
		<span aria-hidden="true">{payload.now.icon}</span>
		<strong>{payload.now.temp}</strong>
		<span class="detail">{payload.now.label} · wind {payload.now.wind}</span>
	</p>
	{#if payload.today}<p><strong>Today</strong> {payload.today}</p>{/if}
	{#if payload.tomorrow}<p><strong>Tomorrow</strong> {payload.tomorrow}</p>{/if}
{:else if !payload.error}
	<p class="muted">Getting the forecast…</p>
{/if}

<style>
	.now {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 1.1rem;
	}
</style>
