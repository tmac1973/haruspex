<script lang="ts">
	/**
	 * Modal shown when the agent wants to run an MCP tool that is not provably
	 * read-only. Mounted once in the root layout — subscribes to the mcpApproval
	 * store and becomes visible whenever a prompt is pending.
	 *
	 * Backdrop and Esc don't dismiss, matching the command and sandbox modals:
	 * silently dropping "is it OK to let this third-party server do this?" is a
	 * footgun.
	 *
	 * The point of this card is that the user can actually judge the request, so
	 * it shows all four things they need — which server, which tool, what the
	 * tool says it does, and the arguments the model actually chose. Approving a
	 * bare tool name is approving nothing in particular.
	 */
	import Modal from './Modal.svelte';
	import ModalButton from './ModalButton.svelte';
	import { getPendingMcpApproval, resolveMcpApproval } from '$lib/stores/mcpApproval.svelte';

	const pending = $derived(getPendingMcpApproval());

	/**
	 * The hints worth surfacing, in plain words. `readOnlyHint` is never shown:
	 * a read-only tool does not reach this modal at all.
	 */
	const hints = $derived.by(() => {
		const a = pending?.annotations;
		if (!a) return [];
		const out: string[] = [];
		if (a.destructiveHint === true) out.push('may delete or overwrite things');
		if (a.idempotentHint === false) out.push('repeating it has additional effect');
		if (a.openWorldHint === true) out.push('reaches services outside this machine');
		return out;
	});

	/**
	 * True when the server published no annotations at all. Worth saying out
	 * loud: this is the case where the prompt exists *because* nothing is known,
	 * rather than because something alarming was declared.
	 */
	const unannotated = $derived(pending?.annotations == null);

	const argsPreview = $derived(
		pending && Object.keys(pending.args).length > 0 ? JSON.stringify(pending.args, null, 2) : null
	);
</script>

<Modal open={pending != null} maxWidth={640} labelledBy="mcp-approval-title">
	{#if pending}
		<h2 id="mcp-approval-title">Allow {pending.serverLabel} to run this?</h2>
		<p>
			The assistant wants to run <strong>{pending.toolName}</strong> on
			<strong>{pending.serverLabel}</strong>.
		</p>
		{#if pending.description}
			<p class="description">{pending.description}</p>
		{/if}
		{#if hints.length}
			<p class="hints">This tool {hints.join('; ')}.</p>
		{:else if unannotated}
			<p class="hints">
				This server does not say whether the tool changes anything, so Haruspex asks.
			</p>
		{/if}
		{#if argsPreview}
			<pre class="code-preview"><code>{argsPreview}</code></pre>
		{/if}
		<div class="button-row">
			<ModalButton onclick={() => resolveMcpApproval('allow_always')}>
				{#snippet title()}Always allow this tool{/snippet}
				{#snippet subtitle()}Don't ask again for {pending.toolName} on {pending.serverLabel}{/snippet}
			</ModalButton>
			<ModalButton onclick={() => resolveMcpApproval('allow_once')}>
				{#snippet title()}Allow once{/snippet}
				{#snippet subtitle()}Run it now, ask again next time{/snippet}
			</ModalButton>
			<ModalButton variant="danger" onclick={() => resolveMcpApproval('deny')}>
				{#snippet title()}Deny{/snippet}
				{#snippet subtitle()}Don't run; the model will see a denial{/snippet}
			</ModalButton>
		</div>
	{/if}
</Modal>

<style>
	.description {
		color: var(--text-secondary, #a8a29e);
	}
	.hints {
		color: var(--text-secondary, #a8a29e);
		font-size: 0.9em;
	}
</style>
