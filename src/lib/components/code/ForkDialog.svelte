<script lang="ts">
	/**
	 * "Fork from here": where the fork works. In a git repository it gets its
	 * own worktree on a new branch (the default), or shares this folder and
	 * only reads. Outside git a fork can only share the folder, so it is
	 * read-only and the dialog says why.
	 */
	import Modal from '#lib/components/Modal.svelte';
	import ModalButton from '#lib/components/ModalButton.svelte';
	import type { CodeForkMode } from '#lib/ipc/gen/CodeForkMode.ts';
	import type { GitStatus } from '#lib/code/git.ts';

	let {
		open,
		git,
		onfork,
		oncancel
	}: {
		open: boolean;
		/** The session folder's git state; null outside a repo or without git. */
		git: GitStatus | null;
		/** Resolves once the fork exists; the dialog shows progress meanwhile. */
		onfork: (mode: CodeForkMode) => Promise<void>;
		oncancel: () => void;
	} = $props();

	let working = $state<CodeForkMode | null>(null);

	async function pick(mode: CodeForkMode) {
		if (working) return;
		working = mode;
		try {
			await onfork(mode);
		} finally {
			working = null;
		}
	}

	function cancel() {
		if (!working) oncancel();
	}
</script>

<Modal {open} maxWidth={460} labelledBy="fork-dialog-title" dismissable onclose={cancel}>
	<h2 id="fork-dialog-title">Fork session</h2>
	{#if working === 'worktree'}
		<p class="status" role="status">Creating the worktree…</p>
	{:else if working}
		<p class="status" role="status">Forking…</p>
	{:else if git}
		<p>Where should the fork work?</p>
		<div class="choices">
			<ModalButton autofocus onclick={() => pick('worktree')}>
				{#snippet title()}New worktree{/snippet}
				{#snippet subtitle()}Its own folder and branch beside the repository. Recommended.{/snippet}
			</ModalButton>
			<ModalButton variant="subtle" onclick={() => pick('readOnly')}>
				{#snippet title()}Same folder, read-only{/snippet}
				{#snippet subtitle()}Reads and searches here; no edits.{/snippet}
			</ModalButton>
		</div>
	{:else}
		<p
			class="notice"
			title="Two sessions editing one folder would overwrite each other. A git repository lets a fork work in its own worktree instead."
		>
			This folder isn't in a git repository, so the fork shares it and is read-only.
		</p>
		<div class="choices">
			<ModalButton autofocus onclick={() => pick('readOnly')}>
				{#snippet title()}Fork read-only{/snippet}
			</ModalButton>
		</div>
	{/if}
	<div class="button-row">
		<ModalButton variant="subtle" onclick={cancel}>
			{#snippet title()}Cancel{/snippet}
		</ModalButton>
	</div>
</Modal>

<style>
	.choices {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.notice {
		color: var(--text-secondary);
	}

	.status {
		color: var(--text-secondary);
	}

	.button-row {
		margin-top: 16px;
	}
</style>
