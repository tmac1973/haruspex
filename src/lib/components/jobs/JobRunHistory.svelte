<script lang="ts">
	import { getRunsForJob, loadRunsForJob, type JobRunSummary } from '$lib/stores/jobRuns.svelte';

	interface Props {
		jobId: number;
		selectedRunId: number | null;
		onselect: (runId: number) => void;
	}

	const { jobId, selectedRunId, onselect }: Props = $props();

	const runs = $derived(getRunsForJob(jobId));

	$effect(() => {
		void loadRunsForJob(jobId);
	});

	function formatWhen(ms: number): string {
		const d = new Date(ms);
		const now = new Date();
		const sameDay = d.toDateString() === now.toDateString();
		if (sameDay) {
			return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		}
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function durationLabel(run: JobRunSummary): string {
		if (run.started_at && run.finished_at) {
			const sec = Math.max(1, Math.round((run.finished_at - run.started_at) / 1000));
			if (sec < 60) return `${sec}s`;
			const min = Math.floor(sec / 60);
			const rem = sec % 60;
			return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
		}
		if (run.status === 'running') return 'in progress';
		return '';
	}
</script>

<div class="history">
	<div class="header">
		<span class="title">History</span>
	</div>
	<div class="rows">
		{#if runs.length === 0}
			<div class="empty">No runs yet.</div>
		{:else}
			{#each runs as run (run.id)}
				<button
					type="button"
					class="row"
					class:selected={selectedRunId === run.id}
					onclick={() => onselect(run.id)}
				>
					<div class="row-top">
						<span class="when">{formatWhen(run.queued_at)}</span>
						<span class="status status-{run.status}">{run.status}</span>
					</div>
					<div class="row-bottom">
						<span class="trigger">{run.trigger}</span>
						<span class="duration">{durationLabel(run)}</span>
					</div>
				</button>
			{/each}
		{/if}
	</div>
</div>

<style>
	.history {
		width: 220px;
		min-width: 220px;
		border-left: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		background: var(--bg-secondary);
	}

	.header {
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
	}

	.title {
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-secondary);
		font-weight: 600;
	}

	.rows {
		flex: 1;
		overflow-y: auto;
	}

	.empty {
		padding: 16px 12px;
		font-size: 0.82rem;
		color: var(--text-secondary);
		font-style: italic;
	}

	.row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		text-align: left;
		padding: 8px 12px;
		border: none;
		border-bottom: 1px solid var(--border);
		background: transparent;
		color: var(--text-primary);
		cursor: pointer;
	}

	.row:hover {
		background: var(--bg-primary);
	}

	.row.selected {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
	}

	.row-top,
	.row-bottom {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 6px;
	}

	.when {
		font-size: 0.82rem;
		font-weight: 500;
	}

	.status {
		font-size: 0.66rem;
		padding: 1px 6px;
		border-radius: 999px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		border: 1px solid var(--border);
		color: var(--text-secondary);
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
	.status-cancelled,
	.status-interrupted {
		background: var(--error-bg);
		border-color: var(--error-border);
		color: var(--error-text);
	}

	.trigger,
	.duration {
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.duration {
		font-variant-numeric: tabular-nums;
	}
</style>
