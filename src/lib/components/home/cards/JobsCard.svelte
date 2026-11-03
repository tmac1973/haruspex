<script lang="ts">
	/** Home's Jobs card: the run going now, the queue, and the latest runs of any job. */
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
	import type { RecentRun } from '#lib/ipc/gen/RecentRun.ts';
	import { getCurrentRun, getQueueDepth } from '#lib/agent/jobs/runner.svelte.ts';
	import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';
	import { selectJob } from '#lib/stores/jobsTabSelection.svelte.ts';
	import { dbQuery } from '#lib/stores/dbCall.ts';
	import { lastActive } from '#lib/code/sessionList.ts';
	import { activeRun, currentRunLine, runProgress, runStatusLabel } from '#lib/home/jobsCard.ts';
	import { getJobType } from '#lib/agent/jobs/types/index.ts';

	// Home hands every card its row; a live card keeps nothing in it.
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	let { card }: { card: HomeCard } = $props();

	const RECENT = 5;

	const current = $derived(activeRun(getCurrentRun()));
	const queued = $derived(getQueueDepth());
	const progress = $derived(current ? runProgress(current) : null);
	let recent = $state<RecentRun[]>([]);

	// A run starting, finishing or joining the queue changes one of these.
	const runKey = $derived(`${current?.id ?? ''}:${current?.status ?? ''}:${queued}`);
	$effect(() => {
		void runKey;
		let stale = false;
		void dbQuery<RecentRun[]>({
			cmd: 'db_job_runs_list_recent',
			category: 'home',
			args: { limit: RECENT },
			fallback: [],
			onError: 'loading recent job runs failed'
		}).then((rows) => {
			if (!stale) recent = rows;
		});
		return () => {
			stale = true;
		};
	});

	function open(jobId: number, runId: number | null) {
		selectJob(jobId, runId);
		setActiveTab('jobs');
	}
</script>

{#if current}
	<button class="row current" onclick={() => open(current.jobId, current.id)}>
		<span class="name">{current.jobName}</span>
		<span class="detail"
			>{currentRunLine(current, getJobType(current.jobType)?.background ?? false)}</span
		>
	</button>
	{#if progress !== null}
		<div class="bar"><span style:width="{Math.round(progress * 100)}%"></span></div>
	{/if}
{:else}
	<p class="muted">Nothing running.</p>
{/if}
{#if queued > 0}
	<p class="muted"><span class="count">{queued}</span> queued</p>
{/if}

{#if recent.length > 0}
	<h4>Recent</h4>
	<ul>
		{#each recent as run (run.id)}
			<li>
				<button class="row" onclick={() => open(run.job_id, run.id)}>
					<span class="name">{run.job_name}</span>
					<span class="detail" class:failed={run.status === 'failed'}>
						{runStatusLabel(run.status)}
						{#if run.finished_at}· {lastActive(run.finished_at)}{/if}
					</span>
				</button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	h4 {
		margin: 10px 0 4px;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 8px;
		width: 100%;
		padding: 4px 6px;
		margin: 0 -6px;
		border: none;
		border-radius: 4px;
		background: none;
		color: var(--text-primary);
		text-align: left;
		cursor: pointer;
		font-size: inherit;
	}

	.row:hover {
		background: var(--bg-primary);
	}

	.row.current {
		background: var(--accent-soft);
	}

	.row.current .name {
		font-weight: 600;
	}

	.row.current .detail,
	.count {
		color: var(--accent);
	}

	.count {
		font-weight: 600;
	}

	.bar {
		height: 4px;
		margin: 4px 0 6px;
		border-radius: 2px;
		background: var(--border);
		overflow: hidden;
	}

	.bar span {
		display: block;
		height: 100%;
		border-radius: 2px;
		background: var(--accent);
		transition: width 0.3s;
	}

	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.detail {
		flex-shrink: 0;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	.detail.failed {
		color: var(--error-text);
	}

	.muted {
		margin: 4px 0;
		color: var(--text-secondary);
	}
</style>
