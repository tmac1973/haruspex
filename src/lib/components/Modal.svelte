<script lang="ts">
	/**
	 * Generic modal primitive: full-screen darkened backdrop + centered
	 * dialog with shared chrome. Visible while `open` is true.
	 *
	 * Used by FileConflictModal, SandboxApprovalModal, ShellPane's risky-
	 * command prompt (deliberate dismissal — no `dismissable`), plus
	 * HelpModal and StartupNoticeDialog.
	 *
	 * Opt-in extras (default off so the data-loss prompts stay byte-for-
	 * byte unchanged):
	 *  - `title`        → renders a header row (title + × close button) and
	 *                     a scrollable body. Omit it to render children
	 *                     directly in the padded box (the original layout).
	 *  - `dismissable`  → Esc and backdrop mousedown call `onclose` (via the
	 *                     shared `dismissable` action).
	 *
	 * Pair with ModalButton for the action row to keep button styling
	 * consistent across modals.
	 */
	import type { Snippet } from 'svelte';
	import { dismissable as dismissableAction } from '$lib/actions/dismissable';

	interface Props {
		open: boolean;
		/** Max-width of the dialog in CSS pixels. */
		maxWidth?: number;
		/** id of the element that labels the dialog (a11y). With `title`, it's
		 *  applied to the header heading; otherwise put it on your own heading. */
		labelledBy?: string;
		/** When set, renders a header row with this title + a close button. */
		title?: string;
		/** Allow Esc / backdrop click to dismiss (calls `onclose`). */
		dismissable?: boolean;
		/** Required when `title` or `dismissable` is set. */
		onclose?: () => void;
		children: Snippet;
	}

	let {
		open,
		maxWidth = 520,
		labelledBy,
		title,
		dismissable = false,
		onclose,
		children
	}: Props = $props();
</script>

{#if open}
	<div
		class="modal-backdrop"
		use:dismissableAction={() => {
			if (dismissable) onclose?.();
		}}
	>
		<div
			class="modal"
			class:has-header={title}
			role="dialog"
			aria-modal="true"
			aria-labelledby={labelledBy}
			style:max-width="{maxWidth}px"
		>
			{#if title}
				<div class="modal-head">
					<h2 id={labelledBy}>{title}</h2>
					<button class="modal-close" onclick={onclose} aria-label="Close">×</button>
				</div>
				<div class="modal-body">
					{@render children()}
				</div>
			{:else}
				{@render children()}
			{/if}
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

	/* Header variant: the box becomes a flex column with a sticky-feeling
	   header and an independently scrolling body. */
	.modal.has-header {
		padding: 0;
		display: flex;
		flex-direction: column;
		max-height: calc(100vh - 48px);
		overflow: hidden;
	}

	.modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 18px 24px 12px;
		border-bottom: 1px solid var(--border);
	}

	/* Specific enough to beat the `.modal :global(h2)` content rule below
	   (which would otherwise add a bottom margin to the header title). */
	.modal.has-header .modal-head h2 {
		margin: 0;
		font-size: 1.15rem;
		color: var(--text-primary);
	}

	.modal-body {
		padding: 8px 24px 20px;
		overflow-y: auto;
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
