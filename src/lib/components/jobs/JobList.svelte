<script lang="ts" module>
	import { SvelteSet } from 'svelte/reactivity';

	/**
	 * Which jobs show the jobs they started. Module state, so it outlives a
	 * trip to another tab; not saved, so a restart starts tidy.
	 */
	const openIds = new SvelteSet<number>();
</script>

<script lang="ts">
	import { getJobs, storedScheduleLabel, type JobSummary } from '#lib/stores/jobs.svelte.ts';
	import { getCurrentRun, getPendingQueue, getQueueDepth } from '#lib/agent/jobs/runner.svelte.ts';
	import {
		ensureTypeAvailabilityLoaded,
		getJobType,
		isJobTypeAvailable
	} from '#lib/agent/jobs/types/index.ts';
	import { activatable } from '#lib/actions/activatable.ts';
	import { startDragResize } from '#lib/utils/dragResize.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { pausedByLean } from '#lib/agent/jobs/types/lean.ts';
	import {
		ancestorIds,
		buildJobTree,
		containsJob,
		filterJobTree,
		flattenJobTree,
		type JobNode
	} from '#lib/components/jobs/jobTree.ts';

	void ensureTypeAvailabilityLoaded();

	interface Props {
		selectedId: number | 'new' | null;
		onselect: (id: number | 'new') => void;
		/** Asks the tab to run this job — it may prompt about unsaved edits first. */
		onrun: (jobId: number) => void;
	}

	const { selectedId, onselect, onrun }: Props = $props();

	const running = $derived(getCurrentRun()?.status === 'running');
	const runningJobId = $derived(running ? (getCurrentRun()?.jobId ?? null) : null);
	/** The badge's tooltip: what is running and what waits, in order. */
	const queueTitle = $derived.by(() => {
		const lines: string[] = [];
		if (running) lines.push(`Running: ${getCurrentRun()?.jobName}`);
		getPendingQueue().forEach((q, i) => lines.push(`${i + 1}. ${q.jobName}`));
		return lines.join('\n');
	});
	const queueDepth = $derived(getQueueDepth());

	function handleRun(e: MouseEvent, jobId: number) {
		e.stopPropagation();
		// Enqueueing is the tab's job: it holds the editor's unsaved-changes
		// state, and running the stored job while newer values sit unsaved in
		// the form is the bug this indirection exists to prevent.
		onrun(jobId);
	}

	const jobs = $derived(getJobs());

	let query = $state('');
	const typeLabel = (job: JobSummary) => {
		const def = getJobType(job.job_type);
		return `${def?.badgeLabel ?? ''} ${job.job_type.replace(/_/g, ' ')}`;
	};
	const tree = $derived(buildJobTree(jobs));
	const rows = $derived(
		flattenJobTree(filterJobTree(tree, query, typeLabel), (id) => openIds.has(id))
	);

	// A selected job is never hidden inside a closed parent: open the way
	// down to it, whether it was clicked, duplicated or just started.
	$effect(() => {
		if (typeof selectedId !== 'number') return;
		for (const id of ancestorIds(jobs, selectedId)) openIds.add(id);
	});

	const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

	/**
	 * A started job's day (one planning job's runs leave several jobs of the
	 * same name), and how many jobs a closed parent holds.
	 */
	function extraMeta(node: JobNode, open: boolean): string {
		let out = '';
		if (node.job.parent_run_id !== null) out += ` · ${dayFormat.format(node.job.created_at)}`;
		if (node.children.length > 0 && !open) out += ` · ${node.descendants} started`;
		return out;
	}

	function toggleOpen(id: number) {
		if (openIds.has(id)) openIds.delete(id);
		else openIds.add(id);
	}

	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && query) {
			e.stopPropagation();
			query = '';
		}
	}

	const MIN_WIDTH = 200;
	const MAX_WIDTH = 520;
	const clampWidth = (w: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
	let width = $state(clampWidth(getSettings().jobsSidebarWidth));

	function startResize(event: MouseEvent) {
		startDragResize(event, {
			width,
			widens: 'right',
			clamp: clampWidth,
			onResize: (w) => (width = w),
			onDone: (w) => updateSettings({ jobsSidebarWidth: w })
		});
	}
</script>

<div class="job-list" style="width: {width}px">
	<div class="header">
		<div class="header-left">
			<span class="title">Jobs</span>
			{#if running || queueDepth > 0}
				<span class="queue-badge" title={queueTitle}>
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
			title="Create a new job"
			onclick={() => onselect('new')}
		>
			+ New
		</button>
	</div>
	{#if jobs.length > 0}
		<div class="search">
			<input
				type="search"
				placeholder="Filter jobs"
				aria-label="Filter jobs"
				title="Matches name, description and type"
				bind:value={query}
				onkeydown={onSearchKeydown}
			/>
		</div>
	{/if}
	<div class="rows">
		{#if jobs.length === 0}
			<div class="empty">
				No jobs yet. Click <strong>+ New</strong> to create one.
			</div>
		{:else if rows.length === 0}
			<div class="empty">No jobs match.</div>
		{:else}
			{#each rows as { node, depth, open } (node.job.id)}
				{@const job = node.job}
				{@const def = getJobType(job.job_type)}
				{@const hasChildren = node.children.length > 0}
				{@const paused = pausedByLean(job.job_type)}
				<div
					class="row"
					class:paused
					class:selected={selectedId === job.id}
					class:child={depth > 0}
					style="padding-left: {6 + depth * 16}px"
					role="button"
					tabindex="0"
					title={job.parent_run_id !== null ? `Started by run ${job.parent_run_id}` : undefined}
					use:activatable={() => onselect(job.id)}
				>
					{#if hasChildren}
						<button
							type="button"
							class="toggle"
							data-no-activate
							aria-expanded={open}
							aria-label={open ? 'Hide the jobs it started' : 'Show the jobs it started'}
							title={`${node.descendants} job${node.descendants === 1 ? '' : 's'} started by this one`}
							disabled={node.viaDescendant}
							onclick={() => toggleOpen(job.id)}
						>
							<span class="chevron" class:open>›</span>
						</button>
					{:else}
						<span class="toggle-space"></span>
					{/if}
					<div class="row-main">
						<span class="name">
							{#if job.id === runningJobId}
								<span class="running-dot" role="img" aria-label="Running" title="Running"></span>
							{:else if !open && runningJobId !== null && containsJob(node, runningJobId)}
								<span
									class="running-dot hollow"
									role="img"
									aria-label="A job it started is running"
									title="A job it started is running"
								></span>
							{/if}
							{job.name}
							<span class="badge {def?.badgeTone ?? ''}">{def?.badgeLabel ?? job.job_type}</span>
							{#if paused}
								<span
									class="paused-tag"
									title="Lean mode runs research jobs alone. Turn it off in Settings → General to run this."
									>Paused by lean mode</span
								>
							{/if}
						</span>
						<span class="meta">
							{storedScheduleLabel(job.schedule_kind, job.schedule_config)}{def?.listMeta?.(job) ??
								''}{extraMeta(node, open)}
						</span>
					</div>
					<button
						type="button"
						class="job-run-btn"
						data-no-activate
						title={paused
							? 'Turn off lean mode in Settings → General to run this'
							: !isJobTypeAvailable(job.job_type)
								? 'This job type is not available on this platform'
								: running
									? 'Run now, or after the current run finishes'
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
	<button
		class="resize-handle"
		onmousedown={startResize}
		aria-label="Drag to resize"
		title="Drag to resize"
	></button>
</div>

<style>
	.running-dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		margin-right: 4px;
		border-radius: 50%;
		background: var(--accent);
		vertical-align: middle;
	}

	.running-dot.hollow {
		background: transparent;
		border: 1.5px solid var(--accent);
		box-sizing: border-box;
	}

	.job-list {
		position: relative;
		flex-shrink: 0;
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

	.search {
		padding: 8px 12px;
		border-bottom: 1px solid var(--border);
	}

	.search input {
		width: 100%;
		box-sizing: border-box;
		padding: 4px 8px;
		font-size: 0.82rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	.search input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.resize-handle {
		position: absolute;
		right: -3px;
		top: 0;
		bottom: 0;
		width: 6px;
		background: transparent;
		border: 0;
		padding: 0;
		cursor: col-resize;
		z-index: 5;
	}

	.resize-handle:hover,
	.resize-handle:active {
		background: color-mix(in srgb, var(--accent) 40%, transparent);
	}

	.toggle,
	.toggle-space {
		flex-shrink: 0;
		width: 18px;
		height: 18px;
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 0;
		border-radius: 3px;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.toggle:hover:not(:disabled) {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.toggle:disabled {
		cursor: default;
	}

	.chevron {
		display: inline-block;
		font-size: 1rem;
		line-height: 1;
		transition: transform 0.1s;
	}

	.chevron.open {
		transform: rotate(90deg);
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
		gap: 4px;
		width: 100%;
		box-sizing: border-box;
		padding: 8px 12px 8px 6px;
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
		overflow-wrap: anywhere;
	}

	.row.child .name {
		font-size: 0.85rem;
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

	/* Kept readable: the row still opens to show its past runs. */
	.row.paused .row-main {
		opacity: 0.6;
	}

	.paused-tag {
		margin-left: 6px;
		font-size: 0.7rem;
		font-weight: 500;
		color: var(--text-secondary);
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
