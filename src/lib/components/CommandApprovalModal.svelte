<script lang="ts">
	/**
	 * Modal shown when the Code tab's run_command tool wants to run a
	 * risk-flagged shell command and the user hasn't enabled auto-approve.
	 * Mounted once per window by the root layout — subscribes to the
	 * codeCommandApproval store and becomes visible whenever a prompt is
	 * pending. Prompts queue: it names who is asking and how many wait behind.
	 *
	 * Backdrop and Esc don't dismiss — silently dropping "is it OK to run this
	 * on my machine?" is a footgun (same restriction as the sandbox modal).
	 */
	import Modal from './Modal.svelte';
	import ModalButton from './ModalButton.svelte';
	import {
		getPendingCommandApproval,
		getQueuedCommandApprovals,
		resolveCommandApproval
	} from '#lib/stores/codeCommandApproval.svelte.ts';

	const pending = $derived(getPendingCommandApproval());
	const reasons = $derived(pending?.reasons.map((r) => r.label).join(', ') ?? '');
	const waiting = $derived(getQueuedCommandApprovals());
</script>

<Modal open={pending != null} maxWidth={640} labelledBy="command-approval-title">
	{#if pending}
		<h2 id="command-approval-title">Run this command?</h2>
		{#if pending.requester || waiting > 0}
			<p class="requester" data-testid="command-approval-requester">
				{#if pending.requester}Asked by <strong>{pending.requester}</strong
					>{/if}{#if pending.requester && waiting > 0}
					·
				{/if}{#if waiting > 0}{waiting} more waiting{/if}
			</p>
		{/if}
		<p>
			The coding agent wants to run a command <strong>on your machine</strong>{#if reasons}
				— flagged: {reasons}{/if}:
		</p>
		<pre class="code-preview"><code>{pending.command}</code></pre>
		<div class="button-row">
			<ModalButton onclick={() => resolveCommandApproval('allow_session')}>
				{#snippet title()}Allow for this session{/snippet}
				{#snippet subtitle()}Don't ask again until I restart or switch projects{/snippet}
			</ModalButton>
			<ModalButton onclick={() => resolveCommandApproval('allow_once')}>
				{#snippet title()}Allow once{/snippet}
				{#snippet subtitle()}Run this command, ask again next time{/snippet}
			</ModalButton>
			<ModalButton variant="danger" onclick={() => resolveCommandApproval('deny')}>
				{#snippet title()}Deny{/snippet}
				{#snippet subtitle()}Don't run; the model will see a denial{/snippet}
			</ModalButton>
		</div>
	{/if}
</Modal>

<style>
	.requester {
		margin-top: -0.25rem;
		color: var(--text-secondary, #a8a29e);
		font-size: 0.9em;
	}
</style>
