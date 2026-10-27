<script lang="ts">
	/**
	 * What a finished render or upload made, under its task card: the file
	 * and its check with Open and Show in folder, or the video's links.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { errMessage } from '#lib/utils/error.ts';
	import { describeCheck } from '#lib/tasks/noticeText.ts';
	import { renderResult, uploadResult, type BackgroundTask } from '#lib/tasks/types.ts';

	let { task }: { task: BackgroundTask } = $props();

	const render = $derived(renderResult(task));
	const upload = $derived(uploadResult(task));
	let error = $state('');

	async function run(command: string, args: Record<string, unknown>) {
		error = '';
		try {
			await invoke(command, args);
		} catch (e) {
			error = errMessage(e);
		}
	}
</script>

{#if render}
	<p class="detail" title={render.absPath}>
		{render.path}{render.check ? ` · ${describeCheck(render.check)}` : ''}
	</p>
	<div class="actions">
		<button
			class="btn"
			type="button"
			onclick={() => run('task_open', { id: task.id, folder: false })}>Open</button
		>
		<button
			class="btn"
			type="button"
			onclick={() => run('task_open', { id: task.id, folder: true })}>Show in folder</button
		>
	</div>
{:else if upload}
	<p class="detail">
		Uploaded, {upload.visibility}.{upload.problems.length ? ` ${upload.problems.join(' ')}` : ''}
	</p>
	<div class="actions">
		<button class="btn" type="button" onclick={() => run('open_url', { url: upload.url })}
			>Open on YouTube</button
		>
		<button class="btn" type="button" onclick={() => run('open_url', { url: upload.studioUrl })}
			>Open in Studio</button
		>
	</div>
{/if}
{#if error}<p class="detail bad">{error}</p>{/if}

<style>
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
