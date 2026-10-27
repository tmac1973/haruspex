<script lang="ts">
	/**
	 * A background task on a card in the conversation or session that started
	 * it: how far it has got, with Cancel, and then what it made or why it
	 * failed. Read from the registry's mirror (`#lib/tasks/store.svelte.ts`).
	 */
	import ReportIssueButton from '#lib/components/ReportIssueButton.svelte';
	import VideoTaskResult from '#lib/components/video/VideoTaskResult.svelte';
	import ImageTaskResult from '#lib/components/tasks/ImageTaskResult.svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { errMessage } from '#lib/utils/error.ts';
	import { getTask, refreshTasks } from '#lib/tasks/store.svelte.ts';
	import { formatDuration } from '#lib/video/report.ts';
	import { progressLine } from '#lib/tasks/progress.ts';

	let { taskId, label }: { taskId: string; label: string } = $props();

	const task = $derived(getTask(taskId));
	const active = $derived(task?.state === 'pending' || task?.state === 'running');
	let missing = $state(false);
	let error = $state('');

	$effect(() => {
		if (!getTask(taskId)) {
			void refreshTasks().then(() => (missing = !getTask(taskId)));
		}
	});

	async function cancel() {
		error = '';
		try {
			await invoke('task_cancel', { id: taskId });
		} catch (e) {
			error = errMessage(e);
		}
	}
</script>

<div class="task-card">
	<div class="head">
		<span class="label">{task?.label ?? label}</span>
		{#if task?.state === 'running'}
			<span class="detail">
				{progressLine(task)}{task.etaSecs != null ? ` · ${formatDuration(task.etaSecs)} left` : ''}
			</span>
		{/if}
	</div>
	{#if active && task}
		{#if task.state === 'pending'}
			<p class="detail">Waiting to start</p>
		{:else if task.percent != null}
			<progress max="100" value={task.percent}></progress>
		{:else}
			<progress></progress>
		{/if}
		<div class="actions">
			<button class="btn" type="button" onclick={() => void cancel()}>Cancel</button>
		</div>
	{:else if task?.state === 'done'}
		{#if task.kind === 'video_render' || task.kind === 'youtube_upload'}
			<VideoTaskResult {task} />
		{:else if task.kind === 'image' && task.result}
			<ImageTaskResult {task} />
		{:else}
			<p class="detail">Done.</p>
		{/if}
	{:else if task?.state === 'failed'}
		<p class="detail bad">{task.error ?? 'It failed.'}</p>
		{#if task.logTail}
			<details>
				<summary class="detail">Output</summary>
				<pre>{task.logTail}</pre>
			</details>
		{/if}
		<div class="actions">
			<ReportIssueButton
				where="Background task"
				error={task.error ?? ''}
				log={() => (task?.logTail ?? '').split('\n').filter(Boolean)}
				logTitle="The task's output"
			/>
		</div>
	{:else if task?.state === 'cancelled'}
		<p class="detail">Cancelled.</p>
	{:else if missing}
		<p class="detail">Task no longer available.</p>
	{/if}
	{#if error}<p class="detail bad">{error}</p>{/if}
</div>

<style>
	.task-card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary, transparent);
	}

	.head {
		display: flex;
		justify-content: space-between;
		gap: 10px;
	}

	.label {
		font-weight: 600;
	}

	progress {
		width: 100%;
	}

	.actions {
		display: flex;
		gap: 8px;
	}

	.detail {
		margin: 0;
		font-size: 0.85em;
		color: var(--text-muted, #888);
	}

	.bad {
		color: var(--error, #c33);
	}

	pre {
		margin: 4px 0 0;
		max-height: 12em;
		overflow: auto;
		font-size: 0.8em;
		white-space: pre-wrap;
	}
</style>
