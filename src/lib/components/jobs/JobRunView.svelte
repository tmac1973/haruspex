<script lang="ts">
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import SearchStepView from '$lib/components/SearchStep.svelte';
	import { cancel, clearCurrentRun, getCurrentRun } from '$lib/agent/jobs/runner.svelte';

	interface Props {
		ondone: () => void;
	}

	const { ondone }: Props = $props();

	const run = $derived(getCurrentRun());

	function statusLabel(): string {
		if (!run) return '';
		switch (run.status) {
			case 'running':
				return 'Running…';
			case 'succeeded':
				return 'Succeeded';
			case 'failed':
				return 'Failed';
			case 'cancelled':
				return 'Cancelled';
		}
	}

	function statusClass(): string {
		return run ? `status status-${run.status}` : 'status';
	}

	function close() {
		clearCurrentRun();
		ondone();
	}
</script>

{#if run}
	<div class="run-view">
		<div class="header">
			<div class="header-left">
				<h3>{run.jobName}</h3>
				<span class={statusClass()}>{statusLabel()}</span>
			</div>
			<div class="header-right">
				{#if run.status === 'running'}
					<button type="button" class="danger" onclick={() => cancel(run.id)}>Cancel</button>
				{:else}
					<button type="button" class="secondary" onclick={close}>Close</button>
				{/if}
			</div>
		</div>

		<div class="step-card">
			<div class="step-label">Step {run.stepIndex + 1} prompt</div>
			<pre class="prompt">{run.stepPrompt}</pre>
		</div>

		{#if run.searchSteps.length > 0}
			<SearchStepView steps={run.searchSteps} />
		{/if}

		{#if run.status === 'running' && run.streaming}
			<ChatMessage message={{ role: 'assistant', content: run.streaming }} isStreaming={true} />
		{:else if run.finalText}
			<ChatMessage message={{ role: 'assistant', content: run.finalText }} />
		{:else if run.status === 'running'}
			<p class="hint">Waiting for first token…</p>
		{/if}

		{#if run.error}
			<div class="error">{run.error}</div>
		{/if}
	</div>
{/if}

<style>
	.run-view {
		flex: 1;
		min-width: 0;
		padding: 16px 20px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	h3 {
		margin: 0;
		font-size: 1rem;
	}

	.status {
		font-size: 0.74rem;
		padding: 2px 8px;
		border-radius: 999px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		border: 1px solid var(--border);
	}

	.status-running {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		border-color: var(--accent);
		color: var(--accent);
	}

	.status-succeeded {
		background: color-mix(in srgb, #16a34a 15%, transparent);
		border-color: #16a34a;
		color: #16a34a;
	}

	.status-failed,
	.status-cancelled {
		background: var(--error-bg);
		border-color: var(--error-border);
		color: var(--error-text);
	}

	.step-card {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		padding: 10px 12px;
	}

	.step-label {
		font-size: 0.74rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-secondary);
		margin-bottom: 6px;
	}

	.prompt {
		margin: 0;
		font-family: inherit;
		font-size: 0.88rem;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text-primary);
	}

	.hint {
		color: var(--text-secondary);
		font-style: italic;
		font-size: 0.85rem;
	}

	.error {
		padding: 8px 10px;
		background: var(--error-bg);
		color: var(--error-text);
		border: 1px solid var(--error-border);
		border-radius: 4px;
		font-size: 0.85rem;
	}

	button {
		padding: 6px 14px;
		border-radius: 6px;
		border: 1px solid var(--border);
		font-size: 0.85rem;
		cursor: pointer;
	}

	button.secondary {
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	button.secondary:hover {
		border-color: var(--text-secondary);
	}

	button.danger {
		background: transparent;
		color: var(--error-text);
		border-color: var(--error-border);
	}

	button.danger:hover {
		background: var(--error-bg);
	}
</style>
