<script lang="ts">
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import JobStepCard from '$lib/components/jobs/JobStepCard.svelte';
	import { getJobRun, type JobRunWithSteps } from '$lib/stores/jobRuns.svelte';

	interface Props {
		runId: number;
		onclose: () => void;
	}

	const { runId, onclose }: Props = $props();

	let run = $state<JobRunWithSteps | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let expandedRendered = $state<Record<number, boolean>>({});

	$effect(() => {
		const id = runId;
		loading = true;
		run = null;
		error = null;
		getJobRun(id)
			.then((r) => {
				if (!r) error = 'Could not load run.';
				else run = r;
			})
			.finally(() => {
				loading = false;
			});
	});

	function formatWhen(ms: number | null): string {
		if (!ms) return '—';
		return new Date(ms).toLocaleString();
	}

	function toggleRendered(idx: number) {
		expandedRendered = { ...expandedRendered, [idx]: !expandedRendered[idx] };
	}
</script>

<div class="run-detail">
	<div class="header">
		<div class="header-left">
			<h3>Run #{runId}</h3>
			{#if run}
				<span class="status-pill status-{run.status}">{run.status}</span>
				<span class="meta">{run.trigger}</span>
				<span class="meta">queued {formatWhen(run.queued_at)}</span>
			{/if}
		</div>
		<div class="header-right">
			<button type="button" class="secondary" onclick={onclose}>Close</button>
		</div>
	</div>

	{#if loading}
		<p class="hint">Loading…</p>
	{:else if error}
		<div class="error">{error}</div>
	{:else if run}
		{#if run.error}
			<div class="error">{run.error}</div>
		{/if}

		<div class="steps">
			{#each run.steps as step (step.id)}
				<JobStepCard stepNumber={step.ordering + 1} status={step.status}>
					<pre class="prompt">{step.prompt_authored}</pre>

					{#if step.ordering > 0 && step.prompt_rendered !== step.prompt_authored}
						<button type="button" class="link" onclick={() => toggleRendered(step.ordering)}>
							{expandedRendered[step.ordering] ? 'Hide' : 'Show'} rendered prompt (with prepended prior
							output)
						</button>
						{#if expandedRendered[step.ordering]}
							<pre class="prompt rendered">{step.prompt_rendered}</pre>
						{/if}
					{/if}

					{#if step.output}
						<ChatMessage message={{ role: 'assistant', content: step.output }} />
					{:else if step.status === 'pending'}
						<p class="hint">Not started.</p>
					{/if}

					{#if step.error}
						<div class="error">{step.error}</div>
					{/if}
				</JobStepCard>
			{/each}
		</div>
	{/if}
</div>

<style>
	.run-detail {
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
		flex-wrap: wrap;
		min-width: 0;
	}

	h3 {
		margin: 0;
		font-size: 1rem;
	}

	.meta {
		font-size: 0.76rem;
		color: var(--text-secondary);
	}

	.steps {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.prompt {
		margin: 0;
		font-family: inherit;
		font-size: 0.85rem;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text-primary);
	}

	.prompt.rendered {
		font-family: ui-monospace, monospace;
		font-size: 0.78rem;
		background: var(--bg-primary);
		padding: 8px;
		border-radius: 4px;
		border: 1px solid var(--border);
		max-height: 240px;
		overflow-y: auto;
	}

	.link {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		font-size: 0.78rem;
		cursor: pointer;
		text-align: left;
		text-decoration: underline;
	}

	.hint {
		font-style: italic;
	}

	.error {
		padding: 8px 10px;
		background: var(--error-bg);
		color: var(--error-text);
		border: 1px solid var(--error-border);
		border-radius: 4px;
		font-size: 0.85rem;
	}

	button.secondary {
		padding: 6px 14px;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.85rem;
		cursor: pointer;
	}

	button.secondary:hover {
		border-color: var(--text-secondary);
	}
</style>
