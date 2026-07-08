<script lang="ts">
	/**
	 * Stacked action button used inside Modal. Renders a bold title line
	 * and a smaller subtitle, left-aligned, full-width.
	 *
	 * The `variant` only controls hover color:
	 *   - 'default'  → accent border on hover (the safe, common case)
	 *   - 'danger'   → red border on hover (overwrite, deny — destructive)
	 *   - 'subtle'   → text-secondary border on hover (cancel, secondary)
	 *
	 * Styled via its own `modal-btn` class (not `btn`) so the global .btn
	 * primitives in +layout.svelte don't bleed into it.
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

<button class="modal-btn {variant}" {onclick}>
	<strong>{@render title()}</strong>
	{#if subtitle}<span>{@render subtitle()}</span>{/if}
</button>

<style>
	.modal-btn {
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

	.modal-btn:hover {
		border-color: var(--accent);
	}

	.modal-btn strong {
		display: block;
		font-size: 0.92rem;
		margin-bottom: 2px;
	}

	.modal-btn span {
		display: block;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.modal-btn.danger:hover {
		border-color: var(--error-text);
	}

	.modal-btn.subtle:hover {
		border-color: var(--text-secondary);
	}
</style>
