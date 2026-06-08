<script lang="ts">
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import SearchStepView from '$lib/components/SearchStep.svelte';
	import JobStepCard from '$lib/components/jobs/JobStepCard.svelte';
	import {
		cancel,
		clearCurrentRun,
		getCurrentRun,
		type RunStepState
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
		return run ? `status-pill status-${run.status}` : 'status-pill';
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
				<JobStepCard stepNumber={step.index + 1} status={step.status}>
					{#snippet headExtra()}
						{#if step.deepResearch}
							<span class="badge">Deep research</span>
						{/if}
					{/snippet}
					<pre class="prompt">{step.promptAuthored}</pre>
					{#if step.index > 0 && step.status !== 'pending'}
						<div class="prepend-note">
							Prior step's output was prepended to this prompt at run time.
						</div>
					{/if}

					{#if step.sizeWarning}
						<div class="warning">⚠ {step.sizeWarning}</div>
					{/if}

					{#if step.searchSteps.length > 0}
						<SearchStepView steps={step.searchSteps} />
					{/if}

					{#if isLiveStep(step) && run.waitingForSlot}
						<p class="hint">Waiting for another inference request to finish…</p>
					{:else if isLiveStep(step) && step.streaming}
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
				</JobStepCard>
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

	.steps {
		display: flex;
		flex-direction: column;
		gap: 12px;
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

	.warning {
		padding: 6px 10px;
		background: color-mix(in srgb, #f59e0b 12%, transparent);
		border: 1px solid color-mix(in srgb, #f59e0b 40%, var(--border));
		border-radius: 4px;
		font-size: 0.8rem;
		line-height: 1.35;
		color: var(--text-primary);
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
