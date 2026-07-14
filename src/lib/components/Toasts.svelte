<script lang="ts">
	/**
	 * Toast host — mounted once in the root layout so toasts render above
	 * every tab. Purely presentational: all state lives in the toasts
	 * store; call `showToast` from anywhere to enqueue one.
	 *
	 * The aria-live container is always in the DOM (screen readers only
	 * announce insertions into a live region that already exists). Enter
	 * animation is a plain CSS `animation` so a global reduced-motion
	 * override can disable it wholesale.
	 */
	import { getToasts, dismissToast, type Toast } from '$lib/stores/toasts.svelte';

	const toasts = $derived(getToasts());

	function runAction(toast: Toast): void {
		toast.onAction?.();
		dismissToast(toast.id);
	}
</script>

<div class="toasts" aria-live="polite">
	{#each toasts as toast (toast.id)}
		<div class="toast {toast.kind}" role={toast.kind === 'error' ? 'alert' : undefined}>
			<span class="message">{toast.message}</span>
			{#if toast.actionLabel}
				<button class="action" onclick={() => runAction(toast)}>{toast.actionLabel}</button>
			{/if}
			<button class="dismiss" onclick={() => dismissToast(toast.id)} aria-label="Dismiss">×</button>
		</div>
	{/each}
</div>

<style>
	.toasts {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 1100;
		display: flex;
		flex-direction: column;
		gap: 8px;
		/* The container is always mounted (live region); don't let it eat
		   clicks aimed at the page underneath. */
		pointer-events: none;
	}

	.toast {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 240px;
		max-width: 380px;
		padding: 10px 12px;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: 8px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
		font-size: 0.85rem;
		color: var(--text-primary);
		animation: toast-in 0.18s ease-out;
	}

	.toast.success {
		border-left-color: var(--success);
	}

	.toast.error {
		border-color: var(--error-border);
		border-left-color: var(--error-text);
		background: var(--error-bg);
		color: var(--error-text);
	}

	.message {
		flex: 1;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.action {
		flex: none;
		background: none;
		border: 1px solid var(--accent);
		color: var(--accent);
		border-radius: 4px;
		padding: 2px 8px;
		font-size: 0.78rem;
		cursor: pointer;
		white-space: nowrap;
	}

	.action:hover {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}

	.dismiss {
		flex: none;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 2px;
		border-radius: 4px;
	}

	.dismiss:hover {
		color: var(--text-primary);
	}

	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
