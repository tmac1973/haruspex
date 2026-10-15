<script lang="ts">
	/**
	 * A `delegate` call's subtask: its label, status and time, a stop button
	 * while it runs, the child's own steps, and its report. Finished cards
	 * fold their steps away. `compact` (the web client) shows the head and the
	 * report only.
	 */
	import type { Snippet } from 'svelte';
	import { subtaskActive, type SubtaskState } from '#lib/code/subtask.ts';
	import { formatCommandDuration } from '#lib/code/commandResult.ts';

	let {
		subtask,
		compact = false,
		onStop,
		steps
	}: {
		subtask: SubtaskState;
		compact?: boolean;
		/** Stop this subtask; absent where it can't be stopped from here. */
		onStop?: (id: string) => void;
		/** Renders the child's steps (`CodeSteps`, which renders this card). */
		steps?: Snippet<[SubtaskState]>;
	} = $props();

	const active = $derived(subtaskActive(subtask));
	const STATUS: Record<SubtaskState['status'], string> = {
		queued: 'waiting for a slot',
		running: 'running',
		done: 'done',
		stopped: 'stopped',
		failed: 'failed'
	};

	// A running subtask's clock ticks; a finished one shows how long it took.
	let now = $state(Date.now());
	$effect(() => {
		if (!active || subtask.startedAt === null) return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});
	const elapsed = $derived.by(() => {
		if (subtask.startedAt === null) return null;
		const end = subtask.endedAt ?? now;
		return formatCommandDuration(Math.max(0, end - subtask.startedAt));
	});
	const calls = $derived(subtask.steps.length);

	let stepsOpen = $state<boolean | null>(null);
	/** Open while it runs, folded once it ends, unless the user chose. */
	const showSteps = $derived(stepsOpen ?? active);
</script>

<div class="card {subtask.status}" data-testid="subtask-card">
	<div class="head">
		<span class="kind">Subtask</span>
		<span class="label" title={subtask.task}>{subtask.label}</span>
		<span class="status" data-testid="subtask-status">{STATUS[subtask.status]}</span>
		{#if elapsed}<span class="time">{elapsed}</span>{/if}
		{#if active && onStop && !compact}
			<button class="stop" title="Stop this subtask" onclick={() => onStop(subtask.id)}>Stop</button
			>
		{/if}
	</div>
	{#if !compact && calls > 0}
		<button class="toggle" onclick={() => (stepsOpen = !showSteps)}>
			{showSteps ? 'Hide' : 'Show'}
			{calls} step{calls === 1 ? '' : 's'}
		</button>
		{#if showSteps && steps}
			<div class="steps">{@render steps(subtask)}</div>
		{/if}
	{/if}
	{#if subtask.status === 'failed' && subtask.error}
		<div class="error">{subtask.error}</div>
	{/if}
	{#if subtask.report}
		<details class="report" open={subtask.status === 'done' && compact}>
			<summary>{subtask.status === 'stopped' ? 'What it had so far' : 'Report'}</summary>
			<div class="report-text">{subtask.report}</div>
		</details>
	{/if}
</div>

<style>
	.card {
		margin: 6px 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-raised);
		font-size: 0.82rem;
		overflow: hidden;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
	}

	.kind {
		color: var(--text-muted);
		font-size: 0.74rem;
	}

	.label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.status,
	.time {
		color: var(--text-secondary);
		font-size: 0.74rem;
		font-variant-numeric: tabular-nums;
	}

	.card.failed .status {
		color: var(--error-text);
	}

	.card.done .status {
		color: var(--success);
	}

	.stop,
	.toggle {
		appearance: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: none;
		color: var(--text-secondary);
		font: inherit;
		font-size: 0.74rem;
		padding: 1px 8px;
		cursor: pointer;
	}

	.stop:hover,
	.toggle:hover {
		color: var(--text-primary);
		border-color: var(--border-strong);
	}

	.toggle {
		margin: 0 10px 6px;
	}

	.steps {
		padding: 0 10px 4px 18px;
		border-left: 2px solid var(--border);
		margin: 0 10px 6px;
	}

	.error {
		padding: 4px 10px 8px;
		color: var(--error-text);
	}

	.report {
		border-top: 1px solid var(--border);
		padding: 4px 10px;
	}

	.report summary {
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 0.78rem;
	}

	.report-text {
		margin: 4px 0;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		color: var(--text-primary);
		line-height: 1.45;
	}
</style>
