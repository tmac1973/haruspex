<script lang="ts">
	import {
		deleteAllJobRuns,
		deleteJobRun,
		getRunsForJob,
		loadRunsForJob,
		type JobRunSummary
	} from '$lib/stores/jobRuns.svelte';
	import { formatDuration } from '$lib/utils/format';

	interface Props {
		jobId: number;
		selectedRunId: number | null;
		onselect: (runId: number) => void;
		onrundeleted?: (runId: number) => void;
		onallrunsdeleted?: () => void;
	}

	const { jobId, selectedRunId, onselect, onrundeleted, onallrunsdeleted }: Props = $props();

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
			return formatDuration(run.finished_at - run.started_at);
		}
		if (run.status === 'running') return 'in progress';
		return '';
	}

	async function confirmDeleteRun(run: JobRunSummary, e: MouseEvent) {
		e.stopPropagation();
		const label = `${formatWhen(run.queued_at)} (${run.status})`;
		if (!window.confirm(`Delete run from ${label}? This cannot be undone.`)) return;
		const ok = await deleteJobRun(jobId, run.id);
		if (ok) onrundeleted?.(run.id);
	}

	async function confirmClearAll() {
		const n = runs.length;
		if (n === 0) return;
		if (
			!window.confirm(
				`Delete all ${n} run${n === 1 ? '' : 's'} for this job? This cannot be undone.`
			)
		)
			return;
		const ok = await deleteAllJobRuns(jobId);
		if (ok) onallrunsdeleted?.();
	}
</script>

<div class="history">
	<div class="header">
		<span class="title">History</span>
		{#if runs.length > 0}
			<button
				type="button"
				class="clear-all"
				onclick={confirmClearAll}
				title="Delete every run in this list. Cannot be undone."
			>
				Clear all
			</button>
		{/if}
	</div>
	<div class="rows thin-scroll">
		{#if runs.length === 0}
			<div class="empty">No runs yet.</div>
		{:else}
			{#each runs as run (run.id)}
				<div
					class="row"
					class:selected={selectedRunId === run.id}
					role="button"
					tabindex="0"
					onclick={() => onselect(run.id)}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							onselect(run.id);
						}
					}}
				>
					<div class="row-content">
						<div class="row-top">
							<span class="when">{formatWhen(run.queued_at)}</span>
							<span
								class="status-dot status-{run.status}"
								title={run.status}
								aria-label={run.status}
							></span>
						</div>
						<div class="row-bottom">
							<span class="trigger">{run.trigger}</span>
							<span class="duration">{durationLabel(run)}</span>
						</div>
					</div>
					<button
						type="button"
						class="delete-btn"
						aria-label="Delete run"
						title="Delete this run"
						onclick={(e) => confirmDeleteRun(run, e)}
					>
						×
					</button>
				</div>
			{/each}
		{/if}
	</div>
</div>

<style>
	.history {
		width: 250px;
		min-width: 250px;
		border-left: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		background: var(--bg-secondary);
	}

	.header {
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.title {
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-secondary);
		font-weight: 600;
	}

	.clear-all {
		background: none;
		border: none;
		padding: 0;
		color: var(--text-secondary);
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		cursor: pointer;
	}

	.clear-all:hover {
		color: var(--error-text);
	}

	.rows {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-gutter: stable;
	}

	.empty {
		padding: 16px 12px;
		font-size: 0.82rem;
		color: var(--text-secondary);
		font-style: italic;
	}

	.row {
		box-sizing: border-box;
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 8px;
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

	.row-content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.row-top,
	.row-bottom {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.when {
		font-size: 0.82rem;
		font-weight: 500;
	}

	.status-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--text-secondary);
		flex-shrink: 0;
		border: 1px solid var(--border);
	}

	.status-dot.status-running {
		background: var(--accent);
		border-color: var(--accent);
	}

	.status-dot.status-succeeded {
		background: var(--success);
		border-color: var(--success);
	}

	.status-dot.status-failed,
	.status-dot.status-cancelled,
	.status-dot.status-interrupted {
		background: var(--error-text);
		border-color: var(--error-border);
	}

	.trigger,
	.duration {
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.duration {
		font-variant-numeric: tabular-nums;
	}

	.delete-btn {
		flex: 0 0 auto;
		width: 22px;
		height: 22px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		padding: 0;
		border-radius: 4px;
		font-size: 1.1rem;
		line-height: 1;
		color: var(--text-secondary);
		background: transparent;
		cursor: pointer;
	}

	.delete-btn:hover,
	.delete-btn:focus-visible {
		color: var(--error-text);
		background: var(--error-bg);
	}
</style>
