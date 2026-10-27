<script lang="ts">
	import ReportIssueButton from '#lib/components/ReportIssueButton.svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { errMessage } from '#lib/utils/error.ts';
	import { getTask, refreshTasks } from '#lib/tasks/store.svelte.ts';
	import { describeCheck } from '#lib/tasks/noticeText.ts';
	import { renderResult, uploadResult } from '#lib/tasks/types.ts';
	import { formatDuration } from '#lib/video/report.ts';

	let { taskId, label }: { taskId: string; label: string } = $props();

	const task = $derived(getTask(taskId));
	const render = $derived(task ? renderResult(task) : null);
	const upload = $derived(task ? uploadResult(task) : null);
	const running = $derived(task?.state === 'running' || task?.state === 'pending');
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
			await invoke('task_open', { id: taskId, folder });
		} catch (e) {
			error = errMessage(e);
		}
	}
</script>

<div class="video-task">
	<div class="head">
		<span class="label">{task?.label ?? label}</span>
		{#if running}
			<span class="detail">
				{Math.round(task?.percent ?? 0)}%{task?.etaSecs != null
					? ` · ${formatDuration(task.etaSecs)} left`
					: ''}
			</span>
		{/if}
	</div>
	{#if running}
		<progress max="100" value={task?.percent ?? 0}></progress>
		<div class="actions">
			<button class="btn" type="button" onclick={() => void cancel()}>Cancel</button>
		</div>
	{:else if render}
		<p class="detail" title={render.absPath}>
			{render.path}{render.check ? ` · ${describeCheck(render.check)}` : ''}
		</p>
		<div class="actions">
			<button class="btn" type="button" onclick={() => void open(false)}>Open</button>
			<button class="btn" type="button" onclick={() => void open(true)}>Show in folder</button>
		</div>
	{:else if upload}
		<p class="detail">
			Uploaded, {upload.visibility}.{upload.problems.length ? ` ${upload.problems.join(' ')}` : ''}
		</p>
		<div class="actions">
			<button class="btn" type="button" onclick={() => void openUrl(upload.url)}
				>Open on YouTube</button
			>
			<button class="btn" type="button" onclick={() => void openUrl(upload.studioUrl)}
				>Open in Studio</button
			>
		</div>
	{:else if task?.state === 'failed'}
		<p class="detail bad" title={task.logTail ?? undefined}>{task.error}</p>
		<div class="actions">
			<ReportIssueButton
				where="Video task"
				error={task.error ?? ''}
				log={() => (task?.logTail ?? '').split('\n').filter(Boolean)}
				logTitle="The task's output"
			/>
		</div>
	{:else if task?.state === 'cancelled'}
		<p class="detail">Cancelled.</p>
	{:else if missing}
		<p class="detail">This task is no longer kept.</p>
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
