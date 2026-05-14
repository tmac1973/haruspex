<script lang="ts">
	/**
	 * Modal shown when the model tries to run code in the Python sandbox
	 * and the user hasn't already approved code execution for this chat.
	 * Mounted once in the root layout — subscribes to the sandboxApproval
	 * store and becomes visible whenever a prompt is pending.
	 *
	 * Buttons depend on the mode:
	 *   - once-per-chat: Allow once / Allow for this chat / Deny
	 *   - every-run:     Allow / Deny
	 *
	 * Backdrop and Esc don't dismiss — same intentional restriction as
	 * FileConflictModal: silent dismiss of "is it OK to run code?" is a
	 * footgun.
	 */
	import Modal from './Modal.svelte';
	import ModalButton from './ModalButton.svelte';
	import { getPendingApproval, resolveApproval } from '$lib/stores/sandboxApproval.svelte';

	const pending = $derived(getPendingApproval());
</script>

<Modal open={pending != null} maxWidth={640} labelledBy="sandbox-approval-title">
	{#if pending}
		<h2 id="sandbox-approval-title">Allow code execution?</h2>
		<p>The model wants to run Python in this chat:</p>
		<pre class="code-preview"><code>{pending.code}</code></pre>
		<div class="button-row">
			{#if pending.mode === 'once-per-chat'}
				<ModalButton onclick={() => resolveApproval('allow_chat')}>
					{#snippet title()}Allow for this chat{/snippet}
					{#snippet subtitle()}Don't ask again until I switch chats{/snippet}
				</ModalButton>
				<ModalButton onclick={() => resolveApproval('allow_once')}>
					{#snippet title()}Allow once{/snippet}
					{#snippet subtitle()}Run this code, ask again next time{/snippet}
				</ModalButton>
			{:else}
				<ModalButton onclick={() => resolveApproval('allow_once')}>
					{#snippet title()}Allow{/snippet}
					{#snippet subtitle()}Run this code{/snippet}
				</ModalButton>
			{/if}
			<ModalButton variant="danger" onclick={() => resolveApproval('deny')}>
				{#snippet title()}Deny{/snippet}
				{#snippet subtitle()}Don't run; the model will see an error{/snippet}
			</ModalButton>
		</div>
	{/if}
</Modal>

<style>
	.code-preview {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 10px 12px;
		max-height: 280px;
		overflow: auto;
		font-size: 0.82rem;
		line-height: 1.45;
		margin: 8px 0 16px 0;
	}

	.code-preview code {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		white-space: pre;
	}

	.button-row {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
</style>
