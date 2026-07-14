<script lang="ts">
	import { getServerState } from '$lib/stores/server.svelte';

	interface Props {
		/** Opens the Log Viewer — same handler as the header logs icon. */
		onOpenLogs?: () => void;
	}

	let { onOpenLogs }: Props = $props();

	const state = $derived(getServerState());
</script>

<button
	class="status-badge"
	data-status={state.status}
	title="Open sidecar logs"
	onclick={() => onOpenLogs?.()}
>
	<span class="dot"></span>
	<span class="label" aria-live="polite">
		{#if state.status === 'ready'}
			Ready
		{:else if state.status === 'starting'}
			Starting…
		{:else if state.status === 'error'}
			Error{state.errorMessage ? `: ${state.errorMessage}` : ''}
		{:else if state.status === 'remote'}
			Remote{state.remoteLabel ? ` · ${state.remoteLabel}` : ''}
		{:else}
			Stopped
		{/if}
	</span>
	{#if state.status === 'error'}
		<span class="view-logs">View logs</span>
	{/if}
</button>

<style>
	.status-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border: none;
		border-radius: 12px;
		font-family: inherit;
		font-size: 0.8rem;
		font-weight: 500;
		color: inherit;
		background: var(--bg-secondary);
		cursor: pointer;
	}

	.status-badge:hover {
		background: color-mix(in srgb, var(--text-secondary) 15%, var(--bg-secondary));
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	[data-status='ready'] .dot {
		background: var(--success);
		box-shadow: 0 0 4px color-mix(in srgb, var(--success) 50%, transparent);
	}

	[data-status='starting'] .dot {
		background: var(--warning);
		animation: pulse 1.2s ease-in-out infinite;
	}

	[data-status='error'] .dot {
		background: var(--error-text);
	}

	[data-status='stopped'] .dot {
		background: var(--text-muted);
	}

	[data-status='remote'] .dot {
		background: var(--accent);
		box-shadow: 0 0 4px color-mix(in srgb, var(--accent) 50%, transparent);
	}

	.label {
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.view-logs {
		flex-shrink: 0;
		color: var(--accent);
		text-decoration: underline;
		font-size: 0.75rem;
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
