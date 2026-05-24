<script lang="ts">
	import { getJobs, type JobSummary } from '$lib/stores/jobs.svelte';
	import { enqueue, getCurrentRun } from '$lib/agent/jobs/runner.svelte';

	interface Props {
		selectedId: number | 'new' | null;
		onselect: (id: number | 'new') => void;
		onrun: (jobId: number) => void;
	}

	const { selectedId, onselect, onrun }: Props = $props();

	const running = $derived(getCurrentRun()?.status === 'running');

	async function handleRun(e: MouseEvent, jobId: number) {
		e.stopPropagation();
		if (running) return;
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
		<span class="title">Jobs</span>
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
			<div class="empty">No jobs yet.</div>
		{:else}
			{#each jobs as job (job.id)}
				<div
					class="row"
					class:selected={selectedId === job.id}
					role="button"
					tabindex="0"
					onclick={() => onselect(job.id)}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							onselect(job.id);
						}
					}}
				>
					<div class="row-main">
						<span class="name">{job.name}</span>
						<span class="meta">
							{scheduleSummary(job)} · {job.step_count} step{job.step_count === 1 ? '' : 's'}
						</span>
					</div>
					<button
						type="button"
						class="run-btn"
						title={running ? 'Another job is running' : 'Run now'}
						disabled={running || job.step_count === 0}
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
		color: white;
		border-color: var(--accent);
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
		align-items: center;
		gap: 8px;
		width: 100%;
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

	.meta {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.run-btn {
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

	.run-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		border-color: var(--accent);
	}

	.run-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
