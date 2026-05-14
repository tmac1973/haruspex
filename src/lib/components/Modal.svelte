<script lang="ts">
	/**
	 * Generic modal primitive: full-screen darkened backdrop + centered
	 * dialog with shared chrome. Visible while `open` is true.
	 *
	 * Used by FileConflictModal and SandboxApprovalModal. Does NOT trap
	 * focus or close on Esc / backdrop click — both consumers want
	 * deliberate dismissal (any accidental dismiss is a footgun for
	 * data-loss prompts).
	 *
	 * Pair with ModalButton for the action row to keep button styling
	 * consistent across modals.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		/** Max-width of the dialog in CSS pixels. */
		maxWidth?: number;
		/** id of the element inside the slot that labels the dialog (a11y). */
		labelledBy?: string;
		children: Snippet;
	}

	let { open, maxWidth = 520, labelledBy, children }: Props = $props();
</script>

{#if open}
	<div class="modal-backdrop">
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby={labelledBy}
			style:max-width="{maxWidth}px"
		>
			{@render children()}
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 24px;
	}

	.modal {
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 24px 28px;
		width: 100%;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
	}

	.modal :global(h2) {
		margin: 0 0 12px 0;
		font-size: 1.15rem;
		color: var(--text-primary);
	}

	.modal :global(p) {
		margin: 0 0 10px 0;
		color: var(--text-primary);
		font-size: 0.9rem;
		line-height: 1.5;
	}
</style>
