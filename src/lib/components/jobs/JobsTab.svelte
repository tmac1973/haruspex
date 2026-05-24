<script lang="ts">
	import { onMount } from 'svelte';
	import JobList from '$lib/components/jobs/JobList.svelte';
	import JobEditor from '$lib/components/jobs/JobEditor.svelte';
	import { isJobsLoaded, loadJobs } from '$lib/stores/jobs.svelte';

	let selectedId = $state<number | 'new' | null>(null);

	onMount(() => {
		if (!isJobsLoaded()) {
			loadJobs();
		}
	});

	function selectJob(id: number | 'new') {
		selectedId = id;
	}

	function clearSelection() {
		selectedId = null;
	}
</script>

<div class="jobs-tab">
	<JobList {selectedId} onselect={selectJob} />
	<div class="editor-pane">
		{#if selectedId === null}
			<div class="empty-state">
				<h2>No job selected</h2>
				<p>Pick a job on the left, or create a new one.</p>
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
</div>

<style>
	.jobs-tab {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
	}

	.editor-pane {
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
		margin: 0;
	}
</style>
