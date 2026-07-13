<script lang="ts">
	/**
	 * Confirmation dialog for destructive (or otherwise irreversible)
	 * actions, built on Modal + ModalButton per maintenance.md §9.
	 *
	 * Safe by default: Cancel takes initial focus so Enter never confirms
	 * a destructive action by accident, and Esc / backdrop-click cancel.
	 * Pass `message` for a plain-text body, or `children` for a rich one.
	 */
	import type { Snippet } from 'svelte';
	import Modal from './Modal.svelte';
	import ModalButton from './ModalButton.svelte';

	interface Props {
		open: boolean;
		title: string;
		message?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		destructive?: boolean;
		onconfirm: () => void;
		oncancel: () => void;
		children?: Snippet;
	}

	let {
		open,
		title: titleText,
		message,
		confirmLabel = 'Delete',
		cancelLabel = 'Cancel',
		destructive = true,
		onconfirm,
		oncancel,
		children
	}: Props = $props();
</script>

<Modal {open} maxWidth={440} labelledBy="confirm-dialog-title" dismissable onclose={oncancel}>
	<h2 id="confirm-dialog-title">{titleText}</h2>
	{#if message}
		<p>{message}</p>
	{/if}
	{#if children}
		{@render children()}
	{/if}
	<div class="button-row">
		<ModalButton variant={destructive ? 'danger' : 'default'} onclick={onconfirm}>
			{#snippet title()}{confirmLabel}{/snippet}
		</ModalButton>
		<ModalButton variant="subtle" autofocus onclick={oncancel}>
			{#snippet title()}{cancelLabel}{/snippet}
		</ModalButton>
	</div>
</Modal>

<style>
	/* Spacing override of the global .button-row. */
	.button-row {
		margin-top: 16px;
	}
</style>
