<script lang="ts">
	/**
	 * Asks before the assistant's `capture_screen` takes a screenshot, unless
	 * Settings → Screen says not to. Mounted in the root layout; see
	 * `stores/screenCaptureApproval.svelte.ts`.
	 *
	 * Backdrop and Esc don't dismiss, matching the other approval modals:
	 * silently dropping the question would leave the tool waiting forever.
	 */
	import Modal from '#lib/components/Modal.svelte';
	import ModalButton from '#lib/components/ModalButton.svelte';
	import {
		getPendingScreenCapture,
		resolveScreenCapture
	} from '#lib/stores/screenCaptureApproval.svelte.ts';

	const pending = $derived(getPendingScreenCapture());
</script>

<Modal open={pending != null} maxWidth={520} labelledBy="screen-capture-approval-title">
	{#if pending}
		<h2 id="screen-capture-approval-title">
			{pending.target === 'window' ? 'Take a screenshot of your window?' : 'Take a screenshot?'}
		</h2>
		<p>
			Haruspex hides while it captures {pending.target === 'window'
				? 'the window you were using'
				: 'your screen'}, and the assistant sees the picture.
		</p>
		<div class="button-row">
			<ModalButton onclick={() => resolveScreenCapture('allow')}>
				{#snippet title()}Take it{/snippet}
				{#snippet subtitle()}Capture once, ask again next time{/snippet}
			</ModalButton>
			<ModalButton variant="danger" onclick={() => resolveScreenCapture('deny')}>
				{#snippet title()}Don't{/snippet}
				{#snippet subtitle()}Nothing is captured; the model is told you declined{/snippet}
			</ModalButton>
		</div>
		<p class="help">Settings → Screen can stop this question.</p>
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
