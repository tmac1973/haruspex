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
	import { getPendingConflict, resolveConflict } from '$lib/stores/fileConflict.svelte';

	const pending = $derived(getPendingConflict());
</script>

{#if pending}
	<div class="modal-backdrop">
		<div class="modal" role="dialog" aria-modal="true" aria-labelledby="file-conflict-title">
			<h2 id="file-conflict-title">File already exists</h2>
			<p>
				The model tried to write <code>{pending.path}</code>, but that file already exists in your
				working directory.
			</p>
			<p class="prompt-question">What should happen?</p>
			<div class="button-row">
				<button class="btn overwrite" onclick={() => resolveConflict('overwrite')}>
					<strong>Overwrite</strong>
					<span>Replace the existing file</span>
				</button>
				<button class="btn counter" onclick={() => resolveConflict('counter')}>
					<strong>Keep both</strong>
					<span>Save as a new name (e.g. -2)</span>
				</button>
				<button class="btn cancel" onclick={() => resolveConflict('cancel')}>
					<strong>Cancel</strong>
					<span>Stop and let me decide</span>
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 24px;
	}

	.modal {
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 24px 28px;
		max-width: 520px;
		width: 100%;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
	}

	.modal h2 {
		margin: 0 0 12px 0;
		font-size: 1.15rem;
		color: var(--text-primary);
	}

	.modal p {
		margin: 0 0 10px 0;
		color: var(--text-primary);
		font-size: 0.9rem;
		line-height: 1.5;
	}

	.modal code {
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

	.btn {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		text-align: left;
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.btn:hover {
		border-color: var(--accent);
	}

	.btn strong {
		display: block;
		font-size: 0.92rem;
		margin-bottom: 2px;
	}

	.btn span {
		display: block;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.btn.overwrite:hover {
		border-color: #ef4444;
	}

	.btn.counter:hover {
		border-color: var(--accent);
	}

	.btn.cancel:hover {
		border-color: var(--text-secondary);
	}
</style>
