<script lang="ts">
	/**
	 * Stacked action button used inside Modal. Renders a bold title line
	 * and a smaller subtitle, left-aligned, full-width.
	 *
	 * The `variant` only controls hover color:
	 *   - 'default'  → accent border on hover (the safe, common case)
	 *   - 'danger'   → red border on hover (overwrite, deny — destructive)
	 *   - 'subtle'   → text-secondary border on hover (cancel, secondary)
	 */
	import type { Snippet } from 'svelte';

	type Variant = 'default' | 'danger' | 'subtle';

	interface Props {
		variant?: Variant;
		onclick: () => void;
		title: Snippet;
		subtitle?: Snippet;
	}

	let { variant = 'default', onclick, title, subtitle }: Props = $props();
</script>

<button class="btn {variant}" {onclick}>
	<strong>{@render title()}</strong>
	{#if subtitle}<span>{@render subtitle()}</span>{/if}
</button>

<style>
	.btn {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		text-align: left;
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.btn:hover {
		border-color: var(--accent);
	}

	.btn strong {
		display: block;
		font-size: 0.92rem;
		margin-bottom: 2px;
	}

	.btn span {
		display: block;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.btn.danger:hover {
		border-color: #ef4444;
	}

	.btn.subtle:hover {
		border-color: var(--text-secondary);
	}
</style>
