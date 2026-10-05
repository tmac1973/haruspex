<script lang="ts">
	import { onMount } from 'svelte';
	import JobList from '$lib/components/jobs/JobList.svelte';
	import JobEditor from '$lib/components/jobs/JobEditor.svelte';
	import JobRunView from '$lib/components/jobs/JobRunView.svelte';
	import JobRunHistory from '$lib/components/jobs/JobRunHistory.svelte';
	import JobRunDetail from '$lib/components/jobs/JobRunDetail.svelte';
	import LiveRunBar from '$lib/components/jobs/LiveRunBar.svelte';
	import UnsavedChangesDialog from '$lib/components/jobs/UnsavedChangesDialog.svelte';
	import { isJobsLoaded, loadJobs } from '$lib/stores/jobs.svelte';
	import { enqueue, getCurrentRun } from '$lib/agent/jobs/runner.svelte';

	let selectedId = $state<number | 'new' | null>(null);
	let selectedRunId = $state<number | null>(null);
	const currentRun = $derived(getCurrentRun());
	/**
	 * Whether the run view is showing. A live run no longer takes the pane:
	 * the view opens for a run started here, and when the bar is clicked;
	 * Hide and Close shut it. A run started elsewhere (chained, scheduled,
	 * drained from the queue) leaves it as it was, so a user watching one
	 * chain stage keeps watching the next and a user browsing keeps
	 * browsing. Arriving at the tab with a run going shows it, as before.
	 */
	let runViewOpen = $state(getCurrentRun() !== null);
	const showRunView = $derived(runViewOpen && currentRun !== null);
	const runLive = $derived(currentRun?.status === 'running');
	const numericSelectedId = $derived(typeof selectedId === 'number' ? selectedId : null);

	/** What the editor exposes to this tab. See JobEditor's exported functions. */
	interface EditorApi {
		hasUnsavedChanges: () => boolean;
		saveNow: () => Promise<boolean>;
	}
	let editor = $state<EditorApi | null>(null);

	/** An action deferred behind the unsaved-changes prompt. */
	type PendingAction = { kind: 'select'; id: number | 'new' } | { kind: 'run'; jobId: number };
	let pending = $state<PendingAction | null>(null);
	let savingPending = $state(false);

	onMount(() => {
		if (!isJobsLoaded()) {
			loadJobs();
		}
	});

	/**
	 * Editor edits live in component state until Save writes them to the DB,
	 * and both running and navigating away read the DB — so either one
	 * silently used the stored version. Both now route through here.
	 */
	function guard(action: PendingAction): boolean {
		if (!editor?.hasUnsavedChanges()) return false;
		pending = action;
		return true;
	}

	function selectJob(id: number | 'new') {
		if (id === selectedId) {
			// Re-selecting the job you are on is how you get back to it from
			// the run view.
			runViewOpen = false;
			return;
		}
		if (guard({ kind: 'select', id })) return;
		applySelect(id);
	}

	function applySelect(id: number | 'new') {
		selectedId = id;
		selectedRunId = null;
		runViewOpen = false;
	}

	function clearSelection() {
		selectedId = null;
		selectedRunId = null;
	}

	function requestRun(jobId: number) {
		if (guard({ kind: 'run', jobId })) return;
		void startRun(jobId);
	}

	async function startRun(jobId: number) {
		// Not blocked on a busy runner — the runner FIFO-queues behind the
		// active run, and the queue badge is the feedback for that.
		const runId = await enqueue(jobId, 'manual');
		if (runId !== null) {
			selectedId = jobId;
			selectedRunId = null;
			runViewOpen = true;
		}
	}

	function applyPending() {
		const action = pending;
		pending = null;
		if (!action) return;
		if (action.kind === 'select') applySelect(action.id);
		else void startRun(action.jobId);
	}

	async function savePending() {
		if (!editor || savingPending) return;
		savingPending = true;
		try {
			const saved = await editor.saveNow();
			// A rejected save leaves the editor showing what is wrong; closing
			// the prompt is what lets the user see and fix it.
			if (saved) applyPending();
			else pending = null;
		} finally {
			savingPending = false;
		}
	}

	function selectRun(runId: number) {
		selectedRunId = runId;
	}

	function closeRunDetail() {
		selectedRunId = null;
	}
</script>

<div class="jobs-tab">
	<JobList {selectedId} onselect={selectJob} onrun={requestRun} />
	<div class="center-pane">
		{#if runLive && !showRunView}
			<LiveRunBar onopen={() => (runViewOpen = true)} />
		{/if}
		{#if showRunView}
			<JobRunView ondone={() => (runViewOpen = false)} onhide={() => (runViewOpen = false)} />
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
					bind:this={editor}
					jobId={selectedId}
					onsaved={(id) => (selectedId = id)}
					ondeleted={clearSelection}
					oncancel={clearSelection}
					onduplicated={(id) => (selectedId = id)}
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

<UnsavedChangesDialog
	open={pending !== null}
	saving={savingPending}
	saveLabel={pending?.kind === 'run' ? 'Save, then run' : 'Save and switch'}
	proceedLabel={pending?.kind === 'run' ? 'Run saved version' : 'Switch without saving'}
	proceedDetail={pending?.kind === 'run'
		? 'Runs the job as last saved — your edits are not used.'
		: 'Your edits are discarded.'}
	onsave={savePending}
	onproceed={applyPending}
	oncancel={() => (pending = null)}
/>

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
</style>
