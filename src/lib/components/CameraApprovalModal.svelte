<script lang="ts">
	/**
	 * Asks before a camera tool uses a camera set to Ask in Settings → Cameras.
	 * Mounted in the root layout; see `stores/cameraApproval.svelte.ts`.
	 *
	 * Backdrop and Esc don't dismiss, matching the other approval modals:
	 * silently dropping the question would leave the tool waiting forever.
	 */
	import Modal from '#lib/components/Modal.svelte';
	import ModalButton from '#lib/components/ModalButton.svelte';
	import {
		cameraUseQuestion,
		getPendingCameraUse,
		resolveCameraUse
	} from '#lib/stores/cameraApproval.svelte.ts';

	const pending = $derived(getPendingCameraUse());
</script>

<Modal open={pending != null} maxWidth={520} labelledBy="camera-approval-title">
	{#if pending}
		<h2 id="camera-approval-title">{cameraUseQuestion(pending)}</h2>
		<div class="button-row">
			<ModalButton onclick={() => resolveCameraUse('allow')}>
				{#snippet title()}Allow{/snippet}
				{#snippet subtitle()}This once, ask again next time{/snippet}
			</ModalButton>
			<ModalButton variant="danger" onclick={() => resolveCameraUse('deny')}>
				{#snippet title()}Deny{/snippet}
				{#snippet subtitle()}Nothing is taken; the model is told you declined{/snippet}
			</ModalButton>
		</div>
		<p class="help">Settings → Cameras can set a camera to Allow.</p>
	{/if}
</Modal>

<style>
	.button-row {
		display: flex;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.button-row > :global(*) {
		flex: 1;
	}

	.help {
		margin: 1rem 0 0 0;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}
</style>
