<script lang="ts">
	/**
	 * The player for a generated clip: on its task card and in answers, where
	 * `audio/mountPlayers.ts` mounts one for each clip markdown names. The clip
	 * loads through `playableClip`, since the desktop webview can't play the
	 * cache's own scheme. Save as copies it out of the cache.
	 *
	 * Fullscreen goes to the frame around the video, not the `<video>`:
	 * WebKitGTK (2.54) draws a fullscreen `<video>` as black. WebKit ignores
	 * `controlslist`, so our button sits over its own in the top-left corner.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { save } from '@tauri-apps/plugin-dialog';
	import { errMessage } from '#lib/utils/error.ts';
	import { videoHashFromUrl } from '#lib/videogen/url.ts';
	import { clipFileName, playableClip } from '#lib/videogen/playable.ts';

	let { src, title }: { src: string; title: string } = $props();

	const hash = $derived(videoHashFromUrl(src));
	let loaded = $state<string | undefined>(undefined);
	let mime = $state('video/webm');
	let missing = $state(false);
	let saveNote = $state('');
	let frame = $state<HTMLDivElement | undefined>(undefined);
	let fullscreen = $state(false);

	function toggleFullscreen() {
		if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
		else void frame?.requestFullscreen().catch(() => {});
	}

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
		if (import.meta.env.VITE_HARUSPEX_WEB === '1') {
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
		<div
			class="frame"
			bind:this={frame}
			onfullscreenchange={() => (fullscreen = document.fullscreenElement === frame)}
		>
			<!-- svelte-ignore a11y_media_has_caption -->
			<video src={loaded} controls loop playsinline preload="metadata" aria-label={title}></video>
			<button
				class="fullscreen"
				type="button"
				onclick={toggleFullscreen}
				aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
				title={fullscreen ? 'Exit full screen' : 'Full screen'}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					{#if fullscreen}
						<polyline points="9 4 9 9 4 9"></polyline><polyline points="15 4 15 9 20 9"
						></polyline><polyline points="9 20 9 15 4 15"></polyline><polyline
							points="15 20 15 15 20 15"
						></polyline>
					{:else}
						<polyline points="4 9 4 4 9 4"></polyline><polyline points="15 4 20 4 20 9"
						></polyline><polyline points="4 15 4 20 9 20"></polyline><polyline
							points="20 15 20 20 15 20"
						></polyline>
					{/if}
				</svg>
			</button>
		</div>
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

	.frame {
		position: relative;
		display: flex;
	}

	video {
		width: 100%;
		border-radius: 6px;
		background: #000;
	}

	.frame:fullscreen {
		align-items: center;
		justify-content: center;
		background: #000;
	}

	.frame:fullscreen video {
		height: 100%;
		border-radius: 0;
		object-fit: contain;
	}

	.fullscreen {
		position: absolute;
		top: 6px;
		left: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 32px;
		padding: 0;
		border: none;
		border-radius: 8px;
		background: rgba(30, 30, 30, 0.75);
		color: #fff;
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.frame:hover .fullscreen,
	.fullscreen:focus-visible {
		opacity: 1;
	}

	.fullscreen svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
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
