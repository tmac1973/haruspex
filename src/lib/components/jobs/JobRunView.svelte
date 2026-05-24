<script lang="ts">
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import SearchStepView from '$lib/components/SearchStep.svelte';
	import {
		cancel,
		clearCurrentRun,
		getCurrentRun,
		type RunStepState,
		type StepStatus
	} from '$lib/agent/jobs/runner.svelte';

	interface Props {
		ondone: () => void;
	}

	const { ondone }: Props = $props();

	const run = $derived(getCurrentRun());

	function runStatusLabel(): string {
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

	function runStatusClass(): string {
		return run ? `status status-${run.status}` : 'status';
	}

	function stepStatusLabel(status: StepStatus): string {
		switch (status) {
			case 'pending':
				return 'Pending';
			case 'running':
				return 'Running';
			case 'succeeded':
				return 'Done';
			case 'failed':
				return 'Failed';
			case 'cancelled':
				return 'Cancelled';
		}
	}

	function isLiveStep(step: RunStepState): boolean {
		return step.status === 'running';
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
				<span class={runStatusClass()}>{runStatusLabel()}</span>
			</div>
			<div class="header-right">
				{#if run.status === 'running'}
					<button type="button" class="danger" onclick={() => cancel(run.id)}>Cancel</button>
				{:else}
					<button type="button" class="secondary" onclick={close}>Close</button>
				{/if}
			</div>
		</div>

		<div class="steps">
			{#each run.steps as step (step.index)}
				<div class="step" data-status={step.status}>
					<div class="step-head">
						<span class="step-num">Step {step.index + 1}</span>
						<span class="step-status status-{step.status}">{stepStatusLabel(step.status)}</span>
						{#if step.deepResearch}
							<span class="badge">Deep research</span>
						{/if}
					</div>
					<pre class="prompt">{step.promptAuthored}</pre>
					{#if step.index > 0 && step.status !== 'pending'}
						<div class="prepend-note">
							Prior step's output was prepended to this prompt at run time.
						</div>
					{/if}

					{#if step.searchSteps.length > 0}
						<SearchStepView steps={step.searchSteps} />
					{/if}

					{#if isLiveStep(step) && step.streaming}
						<ChatMessage
							message={{ role: 'assistant', content: step.streaming }}
							isStreaming={true}
						/>
					{:else if step.output}
						<ChatMessage message={{ role: 'assistant', content: step.output }} />
					{:else if isLiveStep(step)}
						<p class="hint">Waiting for first token…</p>
					{/if}

					{#if step.error}
						<div class="error">{step.error}</div>
					{/if}
				</div>
			{/each}
		</div>

		{#if run.error && run.steps.every((s) => s.status !== 'failed' && s.status !== 'cancelled')}
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

	.steps {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.step {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.step[data-status='pending'] {
		opacity: 0.55;
	}

	.step-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.step-num {
		font-size: 0.74rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-secondary);
	}

	.step-status {
		font-size: 0.7rem;
		padding: 1px 6px;
		border-radius: 999px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		border: 1px solid var(--border);
		color: var(--text-secondary);
	}

	.step-status.status-pending {
		color: var(--text-secondary);
	}

	.badge {
		font-size: 0.7rem;
		padding: 1px 6px;
		border-radius: 999px;
		border: 1px solid var(--accent);
		color: var(--accent);
	}

	.prompt {
		margin: 0;
		font-family: inherit;
		font-size: 0.85rem;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text-primary);
	}

	.prepend-note {
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-style: italic;
	}

	.hint {
		color: var(--text-secondary);
		font-style: italic;
		font-size: 0.85rem;
		margin: 0;
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
