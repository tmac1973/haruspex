<script lang="ts">
	/**
	 * Asks once per repo whether its own instructions may reach a turn. Mounted
	 * in the root layout; see `stores/repoTrust.svelte.ts` for why.
	 *
	 * Backdrop and Esc don't dismiss: the turn is waiting on the answer.
	 */
	import Modal from './Modal.svelte';
	import ModalButton from './ModalButton.svelte';
	import { getPendingRepoTrust, resolveRepoTrust } from '#lib/stores/repoTrust.svelte.ts';

	const pending = $derived(getPendingRepoTrust());

	const what = $derived.by(() => {
		if (!pending) return '';
		const parts: string[] = [];
		if (pending.skills > 0) parts.push(`${pending.skills} skill${pending.skills === 1 ? '' : 's'}`);
		if (pending.agentsMd) parts.push('an AGENTS.md');
		return parts.join(' and ');
	});
</script>

<Modal open={pending != null} maxWidth={560} labelledBy="repo-trust-title">
	{#if pending}
		<h2 id="repo-trust-title">Use this repo's instructions?</h2>
		<p>This repo has {what} for the assistant to follow:</p>
		<p class="root">{pending.root}</p>
		<div class="button-row">
			<ModalButton onclick={() => resolveRepoTrust(true)}>
				{#snippet title()}Use them{/snippet}
				{#snippet subtitle()}I know this repo{/snippet}
			</ModalButton>
			<ModalButton variant="danger" onclick={() => resolveRepoTrust(false)}>
				{#snippet title()}Ignore them{/snippet}
				{#snippet subtitle()}The assistant works here without them{/snippet}
			</ModalButton>
		</div>
		<p class="help">You can change this in Settings → Skills.</p>
	{/if}
</Modal>

<style>
	.root {
		margin: 0.5rem 0;
		padding: 0.5rem 0.75rem;
		border-left: 3px solid var(--accent);
		background: var(--bg-secondary);
		border-radius: 0 6px 6px 0;
		font-family: monospace;
		font-size: 0.85rem;
		word-break: break-all;
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
