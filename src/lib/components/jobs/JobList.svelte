<script lang="ts">
	import { getJobs, type JobSummary } from '$lib/stores/jobs.svelte';
	import { enqueue, getCurrentRun, getQueueDepth } from '$lib/agent/jobs/runner.svelte';
	import {
		ensureTypeAvailabilityLoaded,
		getJobType,
		isJobTypeAvailable
	} from '$lib/agent/jobs/types';
	import { activatable } from '$lib/actions/activatable';

	void ensureTypeAvailabilityLoaded();

	interface Props {
		selectedId: number | 'new' | null;
		onselect: (id: number | 'new') => void;
		onrun: (jobId: number) => void;
	}

	const { selectedId, onselect, onrun }: Props = $props();

	const running = $derived(getCurrentRun()?.status === 'running');
	const queueDepth = $derived(getQueueDepth());

	async function handleRun(e: MouseEvent, jobId: number) {
		e.stopPropagation();
		// Don't block on busy — queue it. The runner now FIFO-queues runs
		// behind whatever is currently active.
		const runId = await enqueue(jobId, 'manual');
		if (runId !== null) onrun(jobId);
	}

	const jobs = $derived(getJobs());

	function scheduleSummary(job: JobSummary): string {
		switch (job.schedule_kind) {
			case 'manual':
				return 'Manual';
			case 'hourly':
				return 'Hourly';
			case 'daily': {
				const cfg = parseConfig(job.schedule_config) as { time?: string } | null;
				return cfg?.time ? `Daily · ${cfg.time}` : 'Daily';
			}
			case 'weekly': {
				const cfg = parseConfig(job.schedule_config) as { day?: string; time?: string } | null;
				if (cfg?.day && cfg?.time) return `Weekly · ${cfg.day} ${cfg.time}`;
				return 'Weekly';
			}
			case 'interval': {
				const cfg = parseConfig(job.schedule_config) as { minutes?: number } | null;
				return cfg?.minutes ? `Every ${cfg.minutes}m` : 'Interval';
			}
			default:
				return job.schedule_kind;
		}
	}

	function parseConfig(raw: string | null): unknown {
		if (!raw) return null;
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}
</script>

<div class="job-list">
	<div class="header">
		<div class="header-left">
			<span class="title">Jobs</span>
			{#if running || queueDepth > 0}
				<span
					class="queue-badge"
					title={running
						? `1 running${queueDepth > 0 ? ` · ${queueDepth} queued` : ''}`
						: `${queueDepth} queued`}
				>
					{#if running}1 running{/if}{#if running && queueDepth > 0}
						·
					{/if}{#if queueDepth > 0}{queueDepth} queued{/if}
				</span>
			{/if}
		</div>
		<button
			type="button"
			class="new-btn"
			class:active={selectedId === 'new'}
			onclick={() => onselect('new')}
		>
			+ New
		</button>
	</div>
	<div class="rows">
		{#if jobs.length === 0}
			<div class="empty">
				No jobs yet. Click <strong>+ New</strong> to create one.
			</div>
		{:else}
			{#each jobs as job (job.id)}
				{@const def = getJobType(job.job_type)}
				<div
					class="row"
					class:selected={selectedId === job.id}
					use:activatable={() => onselect(job.id)}
				>
					<div class="row-main">
						<span class="name">
							{job.name}
							<span class="badge {def?.badgeTone ?? ''}">{def?.badgeLabel ?? job.job_type}</span>
						</span>
						<span class="meta">
							{scheduleSummary(job)}{def?.listMeta?.(job) ?? ''}
						</span>
					</div>
					<button
						type="button"
						class="job-run-btn"
						title={!isJobTypeAvailable(job.job_type)
							? 'This job type is not available on this platform'
							: running
								? 'Queue this run after the active one'
								: 'Run now'}
						disabled={(job.step_count === 0 && def?.hasPlannedSteps !== false) ||
							!isJobTypeAvailable(job.job_type)}
						onclick={(e) => handleRun(e, job.id)}
					>
						▶
					</button>
				</div>
			{/each}
		{/if}
	</div>
</div>

<style>
	.job-list {
		width: 260px;
		min-width: 260px;
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		background: var(--bg-secondary);
	}

	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.queue-badge {
		font-size: 0.68rem;
		padding: 1px 6px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		border: 1px solid var(--accent);
		color: var(--accent);
		white-space: nowrap;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.title {
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-secondary);
		font-weight: 600;
	}

	.new-btn {
		padding: 4px 10px;
		font-size: 0.78rem;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		border-radius: 4px;
		cursor: pointer;
	}

	.new-btn:hover {
		border-color: var(--text-secondary);
	}

	.new-btn.active {
		background: var(--accent);
		color: var(--accent-contrast);
		border-color: var(--accent);
	}

	.rows {
		flex: 1;
		overflow-y: auto;
		/* Always reserve scrollbar gutter so the Run button on each row
		   doesn't slide under the panel's right border the moment the list
		   grows tall enough to scroll. */
		scrollbar-gutter: stable;
	}

	.empty {
		padding: 16px 12px;
		font-size: 0.82rem;
		color: var(--text-secondary);
		font-style: italic;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		box-sizing: border-box;
		padding: 8px 12px;
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

	.row-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}

	.name {
		font-size: 0.9rem;
		font-weight: 500;
	}

	.badge {
		display: inline-block;
		margin-left: 6px;
		padding: 0 6px;
		border-radius: 999px;
		font-size: 0.62rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		vertical-align: middle;
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--accent);
	}

	.meta {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.job-run-btn {
		width: 28px;
		height: 28px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--accent);
		border-radius: 4px;
		font-size: 0.78rem;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.job-run-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		border-color: var(--accent);
	}

	.job-run-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
