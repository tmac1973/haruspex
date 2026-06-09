<script lang="ts">
	import { openFeedbackIssue, saveFullDiagnostics } from '$lib/feedback';
	import { errMessage } from '$lib/utils/error';

	type Status =
		| { kind: 'idle' }
		| { kind: 'busy'; message: string }
		| { kind: 'success'; message: string }
		| { kind: 'error'; message: string };

	let status = $state<Status>({ kind: 'idle' });

	async function onSendFeedback() {
		status = { kind: 'busy', message: 'Preparing feedback…' };
		try {
			await openFeedbackIssue();
			status = {
				kind: 'success',
				message:
					'Issue opened in your browser. Review the pre-filled fields, then click Submit on GitHub.'
			};
		} catch (err) {
			status = {
				kind: 'error',
				message: `Failed to open feedback issue: ${errMessage(err)}`
			};
		}
	}

	async function onSaveDiagnostics() {
		status = { kind: 'busy', message: 'Gathering diagnostics…' };
		try {
			const result = await saveFullDiagnostics();
			if (result.kind === 'cancelled') {
				status = { kind: 'idle' };
				return;
			}
			status = { kind: 'success', message: `Saved to ${result.path}` };
		} catch (err) {
			status = {
				kind: 'error',
				message: `Failed to save diagnostics: ${errMessage(err)}`
			};
		}
	}
</script>

<section class="settings-section">
	<h2>Send Feedback</h2>
	<p class="lede">
		Opens a pre-filled GitHub issue in your browser. App version, system info, settings (with API
		keys redacted), and your current session's search statistics are filled in automatically.
		<strong>Review everything before submitting</strong> — the snapshot is personal-to-your-install data.
	</p>
	<div class="actions">
		<button class="btn primary" onclick={onSendFeedback} disabled={status.kind === 'busy'}>
			Open feedback issue…
		</button>
		<button class="btn" onclick={onSaveDiagnostics} disabled={status.kind === 'busy'}>
			Save Full Diagnostics…
		</button>
	</div>
	<p class="hint">
		If logs would help diagnose your issue, use <em>Save Full Diagnostics</em> to export the full bundle
		(logs + lifetime search stats), then drag the file onto the GitHub issue as an attachment.
	</p>
	{#if status.kind !== 'idle'}
		<p class="status" class:error={status.kind === 'error'}>{status.message}</p>
	{/if}
</section>

<style>
	.lede {
		margin: 0 0 12px 0;
		font-size: 0.9rem;
		color: var(--text-secondary);
		line-height: 1.45;
	}

	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.btn {
		padding: 8px 16px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.9rem;
	}

	.btn:hover:not(:disabled) {
		border-color: var(--text-secondary);
	}

	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn.primary {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		font-weight: 500;
	}

	.hint {
		margin: 12px 0 0 0;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.status {
		margin: 12px 0 0 0;
		font-size: 0.85rem;
		color: var(--text-primary);
	}

	.status.error {
		color: var(--accent);
	}
</style>
