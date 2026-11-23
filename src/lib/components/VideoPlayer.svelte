<script lang="ts">
	/**
	 * The player for a generated clip: on its task card and in answers, where
	 * `audio/mountPlayers.ts` mounts one for each clip markdown names. The clip
	 * loads through `playableClip`, since the desktop webview can't play the
	 * cache's own scheme. Save as copies it out of the cache.
	 *
	 * The video and its full-screen button are `VideoFrame`.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { save } from '@tauri-apps/plugin-dialog';
	import { isWebClient } from '#lib/buildFlags.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { videoHashFromUrl } from '#lib/videogen/url.ts';
	import { clipFileName, playableClip } from '#lib/videogen/playable.ts';
	import VideoFrame from '#lib/components/VideoFrame.svelte';

	let { src, title }: { src: string; title: string } = $props();

	const hash = $derived(videoHashFromUrl(src));
	let loaded = $state<string | undefined>(undefined);
	let mime = $state('video/webm');
	let missing = $state(false);
	let saveNote = $state('');

	$effect(() => {
		const h = hash;
		loaded = undefined;
		missing = false;
		if (!h) return;
		void playableClip(h)
			.then((clip) => {
				if (h !== hash) return;
				loaded = clip.url;
				mime = clip.mime;
			})
			.catch(() => {
				if (h === hash) missing = true;
			});
	});

	async function saveAs() {
		if (!hash || !loaded) return;
		const name = clipFileName(title, mime);
		if (isWebClient) {
			const a = document.createElement('a');
			a.href = loaded;
			a.download = name;
			a.click();
			return;
		}
		try {
			const path = await save({
				title: 'Save video',
				defaultPath: name,
				filters: [{ name: 'Video', extensions: [name.split('.').pop() ?? 'webm'] }]
			});
			if (!path) return;
			await invoke('audio_save_as', { hash, path });
			saveNote = `Saved to ${path}`;
		} catch (e) {
			saveNote = `Could not save: ${errMessage(e)}`;
		}
	}
</script>

<div class="video-player">
	{#if missing}
		<p class="note">This video is no longer kept.</p>
	{:else if loaded}
		<VideoFrame src={loaded} {title} loop />
		<div class="row">
			<span class="title">{title}</span>
			<button class="btn" type="button" onclick={() => void saveAs()}>Save as…</button>
		</div>
		{#if saveNote}<p class="note">{saveNote}</p>{/if}
	{:else}
		<p class="note">Loading video…</p>
	{/if}
</div>

<style>
	.video-player {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-width: 480px;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.title {
		font-size: 0.9em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.note {
		margin: 0;
		font-size: 0.85em;
		color: var(--text-muted, #888);
	}
</style>
