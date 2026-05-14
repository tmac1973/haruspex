<script lang="ts">
	/**
	 * Modal shown when a write tool is about to clobber an existing file.
	 * Mounted once in the root layout — subscribes to the fileConflict
	 * store and becomes visible whenever there's a pending conflict.
	 *
	 * Three buttons:
	 *   - Overwrite:  replace the existing file with the new content
	 *   - Keep both:  write to an auto-counter'd filename (report-2.pdf)
	 *   - Cancel:     abort the write, return control to chat with an
	 *                 error the model can explain to the user
	 *
	 * Backdrop clicks and Esc do NOT dismiss — the user has to pick a
	 * button intentionally. That's deliberate: accidental dismissal
	 * could leak into data loss if "cancel" is treated loosely by the
	 * agent loop's error handling.
	 */
	import Modal from './Modal.svelte';
	import ModalButton from './ModalButton.svelte';
	import { getPendingConflict, resolveConflict } from '$lib/stores/fileConflict.svelte';

	const pending = $derived(getPendingConflict());
</script>

<Modal open={pending != null} maxWidth={520} labelledBy="file-conflict-title">
	{#if pending}
		<h2 id="file-conflict-title">File already exists</h2>
		<p>
			The model tried to write <code>{pending.path}</code>, but that file already exists in your
			working directory.
		</p>
		<p class="prompt-question">What should happen?</p>
		<div class="button-row">
			<ModalButton variant="danger" onclick={() => resolveConflict('overwrite')}>
				{#snippet title()}Overwrite{/snippet}
				{#snippet subtitle()}Replace the existing file{/snippet}
			</ModalButton>
			<ModalButton onclick={() => resolveConflict('counter')}>
				{#snippet title()}Keep both{/snippet}
				{#snippet subtitle()}Save as a new name (e.g. -2){/snippet}
			</ModalButton>
			<ModalButton variant="subtle" onclick={() => resolveConflict('cancel')}>
				{#snippet title()}Cancel{/snippet}
				{#snippet subtitle()}Stop and let me decide{/snippet}
			</ModalButton>
		</div>
	{/if}
</Modal>

<style>
	code {
		background: var(--bg-secondary);
		padding: 2px 6px;
		border-radius: 4px;
		font-size: 0.82rem;
		word-break: break-all;
	}

	.prompt-question {
		margin-top: 16px;
		font-weight: 500;
	}

	.button-row {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 12px;
	}
</style>
