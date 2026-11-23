<script lang="ts">
	/**
	 * What a finished render or upload made, under its task card: the render
	 * playing in place (streamed from its folder by `media_http.rs`) with its
	 * check, Open and Show in folder, or the video's links.
	 */
	import VideoFrame from '#lib/components/VideoFrame.svelte';
	import { cannotPlay, openMediaRoot } from '#lib/media/mediaRoot.ts';
	import { splitFilePath } from '#lib/editor/openFiles.ts';
	import { invoke } from '@tauri-apps/api/core';
	import type { IpcCommand } from '#lib/ipc/commands.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { describeCheck } from '#lib/tasks/noticeText.ts';
	import { renderResult, uploadResult, type BackgroundTask } from '#lib/tasks/types.ts';

	let { task }: { task: BackgroundTask } = $props();

	const render = $derived(renderResult(task));
	const upload = $derived(uploadResult(task));
	let error = $state('');
	let playUrl = $state('');
	let playError = $state('');

	$effect(() => {
		const abs = render?.absPath;
		playUrl = '';
		playError = '';
		if (!abs) return;
		const [dir, name] = splitFilePath(abs);
		let release: (() => void) | null = null;
		let gone = false;
		void openMediaRoot(dir)
			.then(async (root) => {
				release = root.release;
				if (gone) return root.release();
				playUrl = await root.url(name);
			})
			.catch((e: unknown) => {
				if (!gone) playError = `Can't play it here: ${errMessage(e)}`;
			});
		return () => {
			gone = true;
			release?.();
		};
	});

	async function run(command: IpcCommand, args: Record<string, unknown>) {
		error = '';
		try {
			await invoke(command, args);
		} catch (e) {
			error = errMessage(e);
		}
	}
</script>

{#if render}
	{#if playUrl && !playError}
		<div class="player">
			<VideoFrame
				src={playUrl}
				title={render.path}
				onerror={() => (playError = cannotPlay(splitFilePath(render.absPath)[1]))}
			/>
		</div>
	{/if}
	{#if playError}<p class="detail">{playError}</p>{/if}
	<p class="detail" title={render.absPath}>
		{render.path}{render.check ? ` · ${describeCheck(render.check)}` : ''}
	</p>
	<div class="actions">
		<button
			class="btn"
			type="button"
			onclick={() => run('task_open', { id: task.id, folder: false })}
		>
			Open
		</button>
		<button
			class="btn"
			type="button"
			onclick={() => run('task_open', { id: task.id, folder: true })}
		>
			Show in folder
		</button>
	</div>
{:else if upload}
	<p class="detail">
		Uploaded, {upload.visibility}.{upload.problems.length ? ` ${upload.problems.join(' ')}` : ''}
	</p>
	<div class="actions">
		<button class="btn" type="button" onclick={() => run('open_url', { url: upload.url })}>
			Open on YouTube
		</button>
		<button class="btn" type="button" onclick={() => run('open_url', { url: upload.studioUrl })}>
			Open in Studio
		</button>
	</div>
{/if}
{#if error}<p class="detail bad">{error}</p>{/if}

<style>
	.player {
		max-width: 480px;
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
