<script lang="ts">
	import { onMount } from 'svelte';
	import JobList from '$lib/components/jobs/JobList.svelte';
	import JobEditor from '$lib/components/jobs/JobEditor.svelte';
	import JobRunView from '$lib/components/jobs/JobRunView.svelte';
	import JobRunHistory from '$lib/components/jobs/JobRunHistory.svelte';
	import JobRunDetail from '$lib/components/jobs/JobRunDetail.svelte';
	import { isJobsLoaded, loadJobs } from '$lib/stores/jobs.svelte';
	import { getCurrentRun } from '$lib/agent/jobs/runner.svelte';

	let selectedId = $state<number | 'new' | null>(null);
	let selectedRunId = $state<number | null>(null);
	const currentRun = $derived(getCurrentRun());
	const showRunView = $derived(currentRun !== null);
	const numericSelectedId = $derived(typeof selectedId === 'number' ? selectedId : null);

	onMount(() => {
		if (!isJobsLoaded()) {
			loadJobs();
		}
	});

	function selectJob(id: number | 'new') {
		selectedId = id;
		selectedRunId = null;
	}

	function clearSelection() {
		selectedId = null;
		selectedRunId = null;
	}

	function onRunStarted(jobId: number) {
		selectedId = jobId;
		selectedRunId = null;
	}

	function selectRun(runId: number) {
		selectedRunId = runId;
	}

	function closeRunDetail() {
		selectedRunId = null;
	}
</script>

<div class="jobs-tab">
	<JobList {selectedId} onselect={selectJob} onrun={onRunStarted} />
	<div class="center-pane">
		{#if showRunView}
			<JobRunView ondone={() => undefined} />
		{:else if selectedRunId !== null}
			{#key selectedRunId}
				<JobRunDetail runId={selectedRunId} onclose={closeRunDetail} />
			{/key}
		{:else if selectedId === null}
			<div class="empty-state">
				<h2>Jobs</h2>
				<p>
					Save a prompt (or a chain of prompts) and run it on demand or on a schedule. Each step
					runs in a fresh conversation against a working directory you choose — useful for recurring
					tasks like "summarize today's headlines and write them to a PDF" or "clean up the unread
					messages in this folder".
				</p>
				<p class="hint">
					Pick a job on the left to edit or view its history — or click <strong>+ New</strong> to create
					one.
				</p>
			</div>
		{:else}
			{#key selectedId}
				<JobEditor
					jobId={selectedId}
					onsaved={(id) => (selectedId = id)}
					ondeleted={clearSelection}
					oncancel={clearSelection}
				/>
			{/key}
		{/if}
	</div>
	{#if numericSelectedId !== null && !showRunView}
		<JobRunHistory
			jobId={numericSelectedId}
			{selectedRunId}
			onselect={selectRun}
			onrundeleted={(runId) => {
				if (selectedRunId === runId) selectedRunId = null;
			}}
			onallrunsdeleted={() => {
				selectedRunId = null;
			}}
		/>
	{/if}
</div>

<style>
	.jobs-tab {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
	}

	.center-pane {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.empty-state {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
		text-align: center;
		padding: 32px;
	}

	.empty-state h2 {
		margin: 0 0 8px 0;
		font-size: 1.2rem;
		color: var(--text-primary);
	}

	.empty-state p {
		margin: 0 0 12px 0;
		max-width: 520px;
		line-height: 1.5;
	}

	.empty-state p:last-child {
		margin-bottom: 0;
	}

	.empty-state .hint {
		font-size: 0.85rem;
		color: var(--text-secondary);
	}
</style>
