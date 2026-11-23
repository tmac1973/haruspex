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
	import TranscriptPane from '#lib/components/TranscriptPane.svelte';
	import { cannotPlay, openMediaRoot, type MediaRoot } from '#lib/media/mediaRoot.ts';
	import { videoSettings } from '#lib/video/args.ts';
	import { formatBytes } from '#lib/utils/format.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { clock } from '#lib/editor/waveform.ts';
	import type { ClipInfo } from '#lib/ipc/gen/ClipInfo.ts';
	import { basename } from '#lib/utils/basename.ts';

	let { workdir, relPath }: { workdir: string; relPath: string } = $props();

	let url = $state('');
	let error = $state('');
	let info = $state<ClipInfo | null>(null);
	let root: MediaRoot | null = null;
	let video = $state<HTMLVideoElement | undefined>(undefined);
	let time = $state(0);
	let showTranscript = $state(false);

	$effect(() => {
		const v = video;
		if (!v) return;
		const follow = () => (time = v.currentTime);
		v.addEventListener('timeupdate', follow);
		v.addEventListener('seeked', follow);
		return () => {
			v.removeEventListener('timeupdate', follow);
			v.removeEventListener('seeked', follow);
		};
	});

	function seek(secs: number): void {
		if (video) video.currentTime = secs;
		time = secs;
	}

	function togglePlay(): void {
		if (!video) return;
		if (video.paused) void video.play().catch(() => {});
		else video.pause();
	}
	const name = $derived(basename(relPath) || relPath);

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
	<div class="body">
		<div class="stage">
			{#if url && !error}
				<VideoFrame
					src={url}
					title={name}
					fill
					bind:video
					onerror={() => (error = cannotPlay(name))}
				/>
			{/if}
			{#if !url && !error}<p class="note">Loading…</p>{/if}
			{#if error}<p class="note error">{error}</p>{/if}
		</div>
		{#if showTranscript}
			<div class="side">
				<TranscriptPane {workdir} {relPath} {time} onseek={seek} ontoggleplay={togglePlay} />
			</div>
		{/if}
	</div>
	<div class="bar">
		<span class="summary">{summary}</span>
		<label title="Read the clip's words beside it, and mark words to cut or replace">
			<input type="checkbox" bind:checked={showTranscript} />
			Transcript
		</label>
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
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		gap: 8px;
	}
	.stage {
		position: relative;
		flex: 3;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.side {
		flex: 2;
		min-width: 16rem;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.side > :global(*) {
		flex: 1;
	}
	label {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.8rem;
		color: var(--text-secondary);
		cursor: pointer;
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
