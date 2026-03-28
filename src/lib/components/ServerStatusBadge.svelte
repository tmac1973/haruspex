<script lang="ts">
	import { getServerState } from '$lib/stores/server.svelte';

	const state = $derived(getServerState());
</script>

<div class="status-badge" data-status={state.status}>
	<span class="dot"></span>
	<span class="label">
		{#if state.status === 'ready'}
			Ready
		{:else if state.status === 'starting'}
			Starting…
		{:else if state.status === 'error'}
			Error{state.errorMessage ? `: ${state.errorMessage}` : ''}
		{:else}
			Stopped
		{/if}
	</span>
</div>

<style>
	.status-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: 12px;
		font-size: 0.8rem;
		font-weight: 500;
		background: var(--bg-secondary);
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	[data-status='ready'] .dot {
		background: #22c55e;
		box-shadow: 0 0 4px #22c55e80;
	}

	[data-status='starting'] .dot {
		background: #eab308;
		animation: pulse 1.2s ease-in-out infinite;
	}

	[data-status='error'] .dot {
		background: #ef4444;
	}

	[data-status='stopped'] .dot {
		background: #9ca3af;
	}

	.label {
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}
</style>
