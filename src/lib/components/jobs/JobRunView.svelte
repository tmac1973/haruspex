<script lang="ts">
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import SearchStepView from '$lib/components/SearchStep.svelte';
	import ThinkingIndicator from '$lib/components/ThinkingIndicator.svelte';
	import JobStepCard from '$lib/components/jobs/JobStepCard.svelte';
	import ContextGauge from '$lib/components/ContextGauge.svelte';
	import { hasStreamingAnswer } from '$lib/agent/think-stream';
	import JobRunStats from '$lib/components/jobs/JobRunStats.svelte';
	import { formatDuration, formatTokens } from '$lib/utils/format';
	import {
		cancel,
		clearCurrentRun,
		getCurrentRun,
		type RunStepState,
		type StepThinkingStats
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
			case 'needs_input':
				return 'Needs input';
		}
	}

	function runStatusClass(): string {
		return run ? `status-pill status-${run.status}` : 'status-pill';
	}

	function isLiveStep(step: RunStepState): boolean {
		return step.status === 'running';
	}

	// Ticks once a second while the run is live so the running step's
	// elapsed label counts up; finished steps use their fixed timestamps.
	let now = $state(Date.now());
	$effect(() => {
		if (run?.status !== 'running') return;
		const timer = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(timer);
	});

	function stepElapsed(step: RunStepState): string | undefined {
		if (step.startedAt == null) return undefined;
		const end = step.finishedAt ?? (isLiveStep(step) ? now : null);
		if (end == null) return undefined;
		return formatDuration(end - step.startedAt);
	}

	function close() {
		clearCurrentRun();
		ondone();
	}

	/**
	 * Per-step reasoning summary. Token and millisecond splits are apportioned
	 * by character ratio (no server reports either per channel), so they are
	 * labelled as estimates rather than presented as counts.
	 */
	function thinkingSummary(t: StepThinkingStats): string {
		const pct = t.totalMs > 0 ? Math.round((t.reasoningMs / t.totalMs) * 100) : 0;
		return `~${formatDuration(t.reasoningMs)} · ~${formatTokens(t.reasoningTokens)} tokens · ${pct}% of generation`;
	}

	/**
	 * Rows for the stats card. A named stage (guided planning) labels itself;
	 * a plain prompt step is "Step N", because its prompt is already the card
	 * above and repeating it here would make the table unreadable.
	 */
	const statsRows = $derived(
		(run?.steps ?? []).map((s) => ({
			label: s.description ? s.promptAuthored : `Step ${s.index + 1}`,
			stats: s.thinking
		}))
	);
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
				<JobStepCard
					stepNumber={step.index + 1}
					status={step.status}
					title={step.description ? step.promptAuthored : undefined}
					elapsed={stepElapsed(step)}
				>
					{#snippet headExtra()}
						{#if step.deepResearch}
							<span class="badge">Deep research</span>
						{/if}
						{#if step.usage}
							<ContextGauge
								promptTokens={step.usage.promptTokens}
								contextSize={run.contextSize}
								label={run.jobName}
								compact
							/>
						{/if}
					{/snippet}
					{#if step.description}
						<!-- Named-stage step (guided planning): show what the stage is
						     doing instead of a prompt — the title is the stage name. -->
						<p class="stage-desc">{step.description}</p>
					{:else}
						<pre class="prompt">{step.promptAuthored}</pre>
						{#if step.index > 0 && step.status !== 'pending'}
							<div class="prepend-note">
								Prior step's output was prepended to this prompt at run time.
							</div>
						{/if}
					{/if}

					{#if step.checklist?.length}
						<ul class="checklist">
							{#each step.checklist as entry, ci (ci)}
								<li class="check-{entry.status}">
									<span class="check-mark">
										{entry.status === 'done'
											? '✓'
											: entry.status === 'blocked'
												? '✗'
												: entry.status === 'running'
													? '▸'
													: '·'}
									</span>
									<span class="check-label">{entry.label}</span>
									{#if entry.detail}<span class="check-detail">{entry.detail}</span>{/if}
								</li>
							{/each}
						</ul>
					{/if}

					{#if step.sizeWarning}
						<div class="warning">⚠ {step.sizeWarning}</div>
					{/if}

					{#if step.searchSteps.length > 0}
						<SearchStepView steps={step.searchSteps} />
					{/if}

					{#if step.reasoning}
						<!-- Most job turns force a final tool, and that path never
						     reaches the streaming synthesis — so this reasoning
						     arrives one model call at a time, not token by token.
						     It is still the only window into a running step. -->
						<details
							class="reasoning"
							open={isLiveStep(step) && !hasStreamingAnswer(step.streaming)}
						>
							<summary>
								<span class="reasoning-title">Reasoning</span>
								{#if step.thinking}
									<span class="reasoning-stat">{thinkingSummary(step.thinking)}</span>
								{/if}
							</summary>
							<pre class="reasoning-body">{step.reasoning}</pre>
						</details>
					{/if}

					{#if isLiveStep(step) && run.waitingForSlot}
						<p class="hint">Waiting for another inference request to finish…</p>
					{:else if isLiveStep(step) && hasStreamingAnswer(step.streaming)}
						<ChatMessage
							message={{ role: 'assistant', content: step.streaming }}
							isStreaming={true}
						/>
					{:else if isLiveStep(step) && !step.reasoning}
						<!-- Live, and nothing to show yet — not even reasoning. -->
						<ThinkingIndicator bare />
					{:else if step.output}
						<ChatMessage message={{ role: 'assistant', content: step.output }} />
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

		<!-- Supersedes the old header roll-up: same source, but the whole
		     accounting rather than one percentage, and it updates live. -->
		<JobRunStats rows={statsRows} contextSize={run.contextSize} />
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

	.checklist {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 0.82rem;
	}

	.checklist li {
		display: flex;
		align-items: baseline;
		gap: 6px;
		color: var(--text-secondary);
	}

	.check-mark {
		width: 1em;
		text-align: center;
		flex-shrink: 0;
	}

	.checklist .check-done .check-mark {
		color: var(--success);
	}

	.checklist .check-blocked {
		color: var(--error-text);
	}

	.checklist .check-running .check-label {
		color: var(--text-primary);
		font-weight: 600;
	}

	.check-detail {
		font-size: 0.74rem;
		opacity: 0.8;
	}

	.reasoning {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		font-size: 0.8rem;
	}

	.reasoning summary {
		cursor: pointer;
		user-select: none;
		padding: 5px 8px;
		display: flex;
		gap: 8px;
		align-items: baseline;
		color: var(--text-secondary);
	}

	.reasoning-title {
		font-weight: 600;
	}

	.reasoning-stat {
		font-size: 0.72rem;
		opacity: 0.85;
	}

	.reasoning-body {
		margin: 0;
		padding: 0 8px 8px;
		max-height: 320px;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-word;
		font-family: inherit;
		font-size: 0.78rem;
		line-height: 1.45;
		color: var(--text-secondary);
	}

	.stage-desc {
		margin: 0;
		font-size: 0.82rem;
		color: var(--text-secondary);
		line-height: 1.4;
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

	.warning {
		padding: 6px 10px;
		background: color-mix(in srgb, var(--warning) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border));
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
