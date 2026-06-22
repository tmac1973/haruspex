<script lang="ts">
	/**
	 * Modal shown when the Code tab's run_command tool wants to run a
	 * risk-flagged shell command and the user hasn't enabled auto-approve.
	 * Mounted once in the root layout — subscribes to the codeCommandApproval
	 * store and becomes visible whenever a prompt is pending.
	 *
	 * Backdrop and Esc don't dismiss — silently dropping "is it OK to run this
	 * on my machine?" is a footgun (same restriction as the sandbox modal).
	 */
	import Modal from './Modal.svelte';
	import ModalButton from './ModalButton.svelte';
	import {
		getPendingCommandApproval,
		resolveCommandApproval
	} from '$lib/stores/codeCommandApproval.svelte';

	const pending = $derived(getPendingCommandApproval());
	const reasons = $derived(pending?.reasons.map((r) => r.label).join(', ') ?? '');
</script>

<Modal open={pending != null} maxWidth={640} labelledBy="command-approval-title">
	{#if pending}
		<h2 id="command-approval-title">Run this command?</h2>
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
