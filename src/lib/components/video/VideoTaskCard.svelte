<script lang="ts">
	import ReportIssueButton from '#lib/components/ReportIssueButton.svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { errMessage } from '#lib/utils/error.ts';
	import { refreshVideoTask, videoTask } from '#lib/video/tasks.svelte.ts';
	import { describeCheck } from '#lib/video/taskWatch.ts';
	import { formatDuration } from '#lib/video/report.ts';

	let { taskId, label }: { taskId: string; label: string } = $props();

	const task = $derived(videoTask(taskId));
	let missing = $state(false);
	let error = $state('');

	$effect(() => {
		if (!videoTask(taskId)) {
			void refreshVideoTask(taskId).then((t) => (missing = !t));
		}
	});

	async function cancel() {
		error = '';
		try {
			await invoke('video_task_cancel', { id: taskId });
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function openUrl(url: string) {
		error = '';
		try {
			await invoke('open_url', { url });
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function open(folder: boolean) {
		error = '';
		try {
			await invoke('video_task_open', { id: taskId, folder });
		} catch (e) {
			error = errMessage(e);
		}
	}
</script>

<div class="video-task">
	<div class="head">
		<span class="label">{task?.label ?? label}</span>
		{#if task?.state === 'running'}
			<span class="detail">
				{Math.round(task.percent)}%{task.etaSecs != null
					? ` · ${formatDuration(task.etaSecs)} left`
					: ''}
			</span>
		{/if}
	</div>
	{#if task?.state === 'running'}
		<progress max="100" value={task.percent}></progress>
		<div class="actions">
			<button class="btn" type="button" onclick={() => void cancel()}>Cancel</button>
		</div>
	{:else if task?.state === 'done'}
		<p class="detail" title={task.absPath}>
			{task.path}{task.check ? ` · ${describeCheck(task.check)}` : ''}
		</p>
		<div class="actions">
			<button class="btn" type="button" onclick={() => void open(false)}>Open</button>
			<button class="btn" type="button" onclick={() => void open(true)}>Show in folder</button>
		</div>
	{:else if task?.state === 'uploaded'}
		<p class="detail">
			Uploaded, {task.visibility}.{task.problems.length ? ` ${task.problems.join(' ')}` : ''}
		</p>
		<div class="actions">
			<button class="btn" type="button" onclick={() => void openUrl(task.url)}
				>Open on YouTube</button
			>
			<button class="btn" type="button" onclick={() => void openUrl(task.studioUrl)}
				>Open in Studio</button
			>
		</div>
	{:else if task?.state === 'failed'}
		<p class="detail bad" title={task.logTail}>{task.message}</p>
		<div class="actions">
			<ReportIssueButton
				where="Video task"
				error={task.message}
				log={() => (task?.logTail ?? '').split('\n').filter(Boolean)}
				logTitle="The task's output"
			/>
		</div>
	{:else if task?.state === 'cancelled'}
		<p class="detail">Cancelled.</p>
	{:else if missing}
		<p class="detail">Ended when the app closed.</p>
	{/if}
	{#if error}<p class="detail bad">{error}</p>{/if}
</div>

<style>
	.video-task {
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
</style>
