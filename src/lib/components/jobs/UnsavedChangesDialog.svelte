<script lang="ts">
	/**
	 * Three-way prompt for leaving a job editor with unsaved changes: save
	 * first, go ahead without saving, or stay put. ConfirmDialog is two-way
	 * (confirm / cancel) and the middle option is the whole point here — the
	 * bug this exists for is a run that silently used the stored job while
	 * the editor held newer values, and "cancel" was never the right answer
	 * to it.
	 *
	 * Cancel takes initial focus, so Enter never commits a choice about
	 * unsaved work by accident (same rule as ConfirmDialog).
	 */
	import Modal from '$lib/components/Modal.svelte';
	import ModalButton from '$lib/components/ModalButton.svelte';

	interface Props {
		open: boolean;
		/** What proceeding does, e.g. 'Run saved version' / 'Switch anyway'. */
		proceedLabel: string;
		/** One line on what happens if they proceed without saving. */
		proceedDetail: string;
		saveLabel: string;
		saving?: boolean;
		onsave: () => void;
		onproceed: () => void;
		oncancel: () => void;
	}

	const {
		open,
		proceedLabel,
		proceedDetail,
		saveLabel,
		saving = false,
		onsave,
		onproceed,
		oncancel
	}: Props = $props();
</script>

<Modal {open} maxWidth={460} labelledBy="unsaved-changes-title" dismissable onclose={oncancel}>
	<h2 id="unsaved-changes-title">Unsaved changes</h2>
	<p>This job has edits you haven't saved yet.</p>
	<div class="button-row">
		<ModalButton variant="default" onclick={onsave}>
			{#snippet title()}{saving ? 'Saving…' : saveLabel}{/snippet}
		</ModalButton>
		<ModalButton variant="subtle" onclick={onproceed}>
			{#snippet title()}{proceedLabel}{/snippet}
			{#snippet subtitle()}{proceedDetail}{/snippet}
		</ModalButton>
		<ModalButton variant="subtle" autofocus onclick={oncancel}>
			{#snippet title()}Cancel{/snippet}
		</ModalButton>
	</div>
</Modal>

<style>
	.button-row {
		margin-top: 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
</style>
