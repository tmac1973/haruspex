<script lang="ts">
	/**
	 * A video in an editor window, streamed from disk by the loopback media
	 * server (`media_http.rs`) so a long recording plays and seeks without
	 * loading it whole. The window's folder is served while the tab is open.
	 * Under it, the length, size and codecs, from ffprobe when it is there.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import VideoFrame from '#lib/components/VideoFrame.svelte';
	import { cannotPlay, openMediaRoot, type MediaRoot } from '#lib/media/mediaRoot.ts';
	import { videoSettings } from '#lib/video/args.ts';
	import { formatBytes } from '#lib/utils/format.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { clock } from '#lib/editor/waveform.ts';
	import type { ClipInfo } from '#lib/ipc/gen/ClipInfo.ts';

	let { workdir, relPath }: { workdir: string; relPath: string } = $props();

	let url = $state('');
	let error = $state('');
	let info = $state<ClipInfo | null>(null);
	let root: MediaRoot | null = null;
	const name = $derived(relPath.split('/').pop() ?? relPath);

	async function load(): Promise<void> {
		error = '';
		url = '';
		try {
			root ??= await openMediaRoot(workdir);
			// A new URL each time, so Reload reads the file again.
			url = `${await root.url(relPath)}?v=${Date.now()}`;
		} catch (e) {
			error = `Could not open ${name}: ${errMessage(e)}`;
		}
		const s = videoSettings();
		info = await invoke<ClipInfo>('video_probe_file', {
			workingDir: workdir,
			path: relPath,
			intro: s.intro,
			outro: s.outro,
			overrides: s.overrides
		}).catch(() => null);
	}

	onMount(() => {
		void load();
		return () => root?.release();
	});

	const summary = $derived.by(() => {
		if (!info) return '';
		const v = info.video;
		const a = info.audio[0];
		return [
			clock(info.durationSecs),
			v ? `${v.width}×${v.height}` : '',
			v && v.fpsDen ? `${Math.round((v.fpsNum / v.fpsDen) * 100) / 100} fps` : '',
			v ? v.codec : '',
			a
				? `${a.codec} ${a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels} ch`}`
				: 'no sound',
			formatBytes(info.sizeBytes)
		]
			.filter(Boolean)
			.join(' · ');
	});
</script>

<div class="video-viewer" data-testid="video-viewer">
	<div class="stage">
		{#if url && !error}
			<VideoFrame src={url} title={name} fill onerror={() => (error = cannotPlay(name))} />
		{/if}
		{#if !url && !error}<p class="note">Loading…</p>{/if}
		{#if error}<p class="note error">{error}</p>{/if}
	</div>
	<div class="bar">
		<span class="summary">{summary}</span>
		<button onclick={() => void load()}>Reload</button>
	</div>
</div>

<style>
	.video-viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.note {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.85rem;
		pointer-events: none;
		padding: 16px;
		text-align: center;
	}
	.note.error {
		color: var(--danger, #ef4444);
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-top: 6px;
	}
	.summary {
		margin-right: auto;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}
</style>
