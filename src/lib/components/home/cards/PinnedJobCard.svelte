<script lang="ts">
	/** A job pinned to Home: what its latest successful run produced, with Run now and Open. */
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
	import ChatMessage from '#lib/components/ChatMessage.svelte';
	import { enqueue, getActiveRunForJob, getPendingQueue } from '#lib/agent/jobs/runner.svelte.ts';
	import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';
	import { selectJob } from '#lib/stores/jobsTabSelection.svelte.ts';
	import { finalOutput, getLatestRun } from '#lib/home/latestRun.svelte.ts';
	import { currentRunLine } from '#lib/home/jobsCard.ts';

	let { card }: { card: HomeCard } = $props();

	const jobId = $derived(card.job_id);
	const latestRun = $derived(jobId === null ? null : getLatestRun(jobId));
	const live = $derived.by(() => {
		const run = jobId === null ? null : getActiveRunForJob(jobId);
		return run?.status === 'running' ? run : null;
	});
	const queued = $derived(getPendingQueue().some((q) => q.jobId === jobId));
	const failed = $derived(latestRun?.latest?.status === 'failed' ? latestRun.latest : null);
	const output = $derived(
		latestRun?.latestSucceeded ? finalOutput(latestRun.latestSucceeded) : null
	);
	let expanded = $state(false);
	/** The output's full height, to offer Show more only when it is cut. */
	let fullHeight = $state(0);
	const CLAMP_PX = 280;

	function open() {
		if (jobId === null) return;
		selectJob(jobId, live?.id ?? latestRun?.latest?.id ?? null);
		setActiveTab('jobs');
	}
</script>

{#if jobId === null}
	<p class="muted">This job was deleted.</p>
{:else}
	{#if live}
		{@const line = currentRunLine(live)}
		<p class="live">{line === 'Running' ? line : `Running · ${line}`}</p>
	{:else if queued}
		<p class="live">Queued</p>
	{/if}
	{#if failed}
		<p class="error" title={failed.error ?? undefined}>
			The last run failed{failed.error ? `: ${failed.error}` : '.'}
		</p>
	{/if}
	{#if output}
		<div class="output" class:clamped={!expanded && fullHeight > CLAMP_PX}>
			<div bind:offsetHeight={fullHeight}>
				<ChatMessage message={{ role: 'assistant', content: output }} />
			</div>
		</div>
		{#if fullHeight > CLAMP_PX}
			<button class="link" onclick={() => (expanded = !expanded)}
				>{expanded ? 'Show less' : 'Show more'}</button
			>
		{/if}
	{:else if latestRun?.latest === null && !live && !queued}
		<p class="muted">No runs yet.</p>
	{/if}
	<div class="actions">
		<button
			onclick={() => void enqueue(jobId, 'manual')}
			disabled={live !== null || queued}
			title={live || queued ? 'This job is already running or queued' : undefined}>Run now</button
		>
		<button onclick={open}>Open</button>
	</div>
{/if}

<style>
	.output {
		position: relative;
	}

	.output.clamped {
		max-height: 280px;
		overflow: hidden;
		mask-image: linear-gradient(to bottom, black 80%, transparent);
	}

	.live,
	.muted {
		margin: 4px 0;
		color: var(--text-secondary);
	}

	.error {
		margin: 4px 0;
		color: var(--error-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.link {
		padding: 0;
		border: none;
		background: none;
		color: var(--accent);
		cursor: pointer;
		font-size: 0.8rem;
	}

	.actions {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}

	.actions button {
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.8rem;
	}

	.actions button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
