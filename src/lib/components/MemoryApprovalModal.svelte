<script lang="ts">
	/**
	 * Modal shown when `remember_this` wants to write a fact to long-term
	 * memory and the user hasn't turned the prompt off. Mounted once in the
	 * root layout — subscribes to the memoryApproval store and becomes visible
	 * whenever a prompt is pending.
	 *
	 * Shows the exact sentence that would be stored, because that sentence is
	 * what gets injected into future conversations. Approving something you
	 * couldn't read would make the prompt theatre.
	 *
	 * Backdrop and Esc don't dismiss, matching the command and sandbox modals:
	 * silently dropping the question would leave the tool waiting forever.
	 */
	import Modal from './Modal.svelte';
	import ModalButton from './ModalButton.svelte';
	import {
		getPendingMemoryApproval,
		resolveMemoryApproval
	} from '$lib/stores/memoryApproval.svelte';

	const pending = $derived(getPendingMemoryApproval());
</script>

<Modal open={pending != null} maxWidth={640} labelledBy="memory-approval-title">
	{#if pending}
		<h2 id="memory-approval-title">Remember this?</h2>
		<p>
			This will be saved and <strong>brought into future conversations</strong>, as a
			{pending.category}:
		</p>
		<p class="memory-preview">{pending.content}</p>
		<div class="button-row">
			<ModalButton onclick={() => resolveMemoryApproval('allow_once')}>
				{#snippet title()}Remember it{/snippet}
				{#snippet subtitle()}Save this one, ask again next time{/snippet}
			</ModalButton>
			<ModalButton onclick={() => resolveMemoryApproval('allow_session')}>
				{#snippet title()}Allow for this session{/snippet}
				{#snippet subtitle()}Save without asking until I restart{/snippet}
			</ModalButton>
			<ModalButton variant="danger" onclick={() => resolveMemoryApproval('deny')}>
				{#snippet title()}Don't save{/snippet}
				{#snippet subtitle()}Nothing is stored; the model is told you declined{/snippet}
			</ModalButton>
		</div>
		<p class="help">
			Everything remembered can be reviewed, edited or deleted in Settings → Remember across chats.
		</p>
	{/if}
</Modal>

<style>
	.memory-preview {
		margin: 0.75rem 0;
		padding: 0.75rem 1rem;
		border-left: 3px solid var(--accent);
		background: var(--bg-secondary);
		border-radius: 0 6px 6px 0;
		font-size: 0.95rem;
		line-height: 1.5;
		color: var(--text-primary);
	}

	.button-row {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.help {
		margin: 1rem 0 0 0;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}
</style>
