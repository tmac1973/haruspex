<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { openFeedbackIssue, saveFullDiagnostics } from '#lib/feedback.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import ModelFeedbackModal from '#lib/components/settings/ModelFeedbackModal.svelte';
	import { errMessage } from '#lib/utils/error.ts';

	let modelFeedback = $state(getSettings().agentFeedbackEnabled);
	let viewing = $state(false);
	let folderError = $state('');

	function toggleModelFeedback() {
		updateSettings({ agentFeedbackEnabled: modelFeedback });
	}

	async function openReports() {
		folderError = '';
		try {
			await invoke('folder_open', { path: await invoke<string>('agent_feedback_dir') });
		} catch (e) {
			folderError = errMessage(e);
		}
	}

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
		<button class="btn btn-primary" onclick={onSendFeedback} disabled={status.kind === 'busy'}>
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

<section class="settings-section">
	<h2>Model feedback on tools</h2>
	<label
		class="toggle-row"
		title="Adds a haruspex_feedback tool to every turn and a short review after each job run. Reports, with the tool calls behind them, are saved as JSON lines on this computer and never sent anywhere. They can include file contents and command output."
	>
		<input type="checkbox" bind:checked={modelFeedback} onchange={toggleModelFeedback} />
		<span>Let the model report problems with Haruspex's tools</span>
	</label>
	<div class="actions folder">
		<button
			class="btn"
			onclick={() => (viewing = true)}
			title="Read the reports with the tool calls behind them, and share them as a GitHub issue."
			>View reports…</button
		>
		<button class="btn" onclick={openReports}>Open reports folder</button>
	</div>
	{#if folderError}
		<p class="status error">{folderError}</p>
	{/if}
</section>

<ModelFeedbackModal open={viewing} onclose={() => (viewing = false)} />

<style>
	.folder {
		margin-top: 12px;
	}

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

	.hint {
		margin: 12px 0 0 0;
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
