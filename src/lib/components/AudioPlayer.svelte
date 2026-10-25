<script lang="ts">
	/**
	 * The player for generated audio: on a tool step card, in Settings →
	 * Music, and in answers, where `audio/playable.ts` mounts one for each
	 * song markdown names. One plays at a time: see `audio/exclusive.ts`.
	 *
	 * Its own controls, not the `<audio>` element's: with the DMA-BUF
	 * renderer off (`main.rs`), WebKitGTK doesn't repaint the native controls
	 * as a song plays, so the time and slider sat still until something else
	 * redrew the window. These update as ordinary DOM from the element's
	 * events.
	 *
	 * `src` is the cache's URL; the song loads through `playableUrl`, since
	 * the desktop webview can't play the cache's own scheme.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { save } from '@tauri-apps/plugin-dialog';
	import { errMessage } from '#lib/utils/error.ts';
	import { audioHashFromUrl } from '#lib/audio/url.ts';
	import { audioExtension, playableSong, songFileName } from '#lib/audio/playable.ts';

	interface Props {
		src: string;
		title: string;
	}
	let { src, title }: Props = $props();

	let loaded = $state<string | undefined>(undefined);
	let mime = $state('audio/mpeg');
	let missing = $state(false);
	const hash = $derived(audioHashFromUrl(src));
	$effect(() => {
		const h = hash;
		loaded = undefined;
		missing = false;
		if (!h) {
			loaded = src;
			return;
		}
		playableSong(h)
			.then((song) => {
				loaded = song.url;
				mime = song.mime;
			})
			.catch(() => (missing = true));
	});

	/** What Save as last did, when there is something to say. */
	let saveNote = $state('');

	/**
	 * Save the song where the user picks: the native dialog and a copy from
	 * the cache on the desktop, a download of the blob on the web client.
	 */
	async function saveAs() {
		if (!hash || !loaded) return;
		const name = songFileName(title, mime);
		if (import.meta.env.VITE_HARUSPEX_WEB === '1') {
			const a = document.createElement('a');
			a.href = loaded;
			a.download = name;
			a.click();
			return;
		}
		try {
			const path = await save({
				title: 'Save song',
				defaultPath: name,
				filters: [{ name: 'Audio', extensions: [audioExtension(mime)] }]
			});
			if (!path) return;
			await invoke('audio_save_as', { hash, path });
			saveNote = `Saved to ${path}`;
		} catch (e) {
			saveNote = `Could not save: ${errMessage(e)}`;
		}
	}

	let audio = $state<HTMLAudioElement | undefined>(undefined);
	let currentTime = $state(0);
	let duration = $state(0);
	let paused = $state(true);

	/** The last volume set on any player, so a new song starts at it. */
	const VOLUME_KEY = 'haruspex-audio-volume';
	function savedVolume(): number {
		try {
			const v = Number(localStorage.getItem(VOLUME_KEY));
			return localStorage.getItem(VOLUME_KEY) !== null && v >= 0 && v <= 1 ? v : 1;
		} catch {
			return 1;
		}
	}
	let volume = $state(savedVolume());
	let muted = $state(false);

	function setVolume(e: Event) {
		volume = Number((e.currentTarget as HTMLInputElement).value);
		muted = volume === 0;
		try {
			localStorage.setItem(VOLUME_KEY, String(volume));
		} catch {
			// Not kept; this player still has it.
		}
	}

	const ready = $derived(!!loaded && Number.isFinite(duration) && duration > 0);

	/**
	 * The length, read from the element rather than bound. WebKitGTK fires
	 * `durationchange` once, at load, with 0 for an MP3 with no length header
	 * (ACE's), then sets the real length when playback starts without firing
	 * it again (measured 2026-10-25), so a binding stayed at 0. Read on every
	 * playback event instead.
	 */
	function syncDuration() {
		if (audio) duration = audio.duration;
	}

	/** `m:ss`, or `--:--` before the length is known. */
	function clock(s: number): string {
		if (!Number.isFinite(s) || s < 0) return '--:--';
		const whole = Math.floor(s);
		return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
	}

	function toggle() {
		if (!audio || !loaded) return;
		if (audio.paused) void audio.play().catch(() => {});
		else audio.pause();
	}

	function seek(e: Event) {
		if (!audio) return;
		audio.currentTime = Number((e.currentTarget as HTMLInputElement).value);
	}
</script>

<figure
	class="audio-player"
	title={missing ? 'This song is no longer in the audio cache.' : undefined}
>
	{#if title}<figcaption>{title}</figcaption>{/if}
	<div class="controls">
		<button
			type="button"
			class="play"
			onclick={toggle}
			disabled={!loaded}
			aria-label={paused ? `Play ${title}` : `Pause ${title}`}
		>
			{#if paused}
				<svg viewBox="0 0 24 24" aria-hidden="true"
					><polygon points="7 4 20 12 7 20 7 4"></polygon></svg
				>
			{:else}
				<svg viewBox="0 0 24 24" aria-hidden="true"
					><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"
					></rect></svg
				>
			{/if}
		</button>
		<span class="time">{clock(currentTime)}</span>
		<input
			type="range"
			class="seek"
			min="0"
			max={ready ? duration : 0}
			step="0.1"
			value={ready ? currentTime : 0}
			oninput={seek}
			disabled={!ready}
			aria-label={`Position in ${title}`}
		/>
		<span class="time">{ready ? clock(duration) : '--:--'}</span>
		<button
			type="button"
			class="mute"
			onclick={() => (muted = !muted)}
			aria-label={muted ? `Unmute ${title}` : `Mute ${title}`}
			title={muted ? 'Unmute' : 'Mute'}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<polygon points="4 9 8 9 13 5 13 19 8 15 4 15 4 9"></polygon>
				{#if muted || volume === 0}
					<line x1="17" y1="9" x2="22" y2="14"></line><line x1="22" y1="9" x2="17" y2="14"></line>
				{:else}
					<path d="M16 9a4 4 0 0 1 0 6"></path>{#if volume > 0.5}<path d="M18.5 6.5a8 8 0 0 1 0 11"
						></path>{/if}
				{/if}
			</svg>
		</button>
		<input
			type="range"
			class="volume"
			min="0"
			max="1"
			step="0.05"
			value={muted ? 0 : volume}
			oninput={setVolume}
			aria-label={`Volume of ${title}`}
		/>
		{#if hash}
			<button
				type="button"
				class="save"
				onclick={saveAs}
				disabled={!loaded}
				aria-label={`Save ${title} as…`}
				title="Save as…"
			>
				<svg viewBox="0 0 24 24" aria-hidden="true"
					><path d="M12 4v11"></path><polyline points="7 10 12 15 17 10"></polyline><path
						d="M5 19h14"
					></path></svg
				>
			</button>
		{/if}
	</div>
	{#if saveNote}<p class="save-note">{saveNote}</p>{/if}
	<audio
		bind:this={audio}
		bind:currentTime
		bind:paused
		bind:volume
		bind:muted
		ondurationchange={syncDuration}
		onloadedmetadata={syncDuration}
		onplay={syncDuration}
		onplaying={syncDuration}
		ontimeupdate={syncDuration}
		preload="metadata"
		src={loaded}
	></audio>
</figure>

<style>
	.audio-player {
		margin: 6px 0 0;
		max-width: 28rem;
	}

	figcaption {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin-bottom: 4px;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
	}

	.play {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-contrast);
		cursor: pointer;
		flex: none;
	}

	.play:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.play svg {
		width: 12px;
		height: 12px;
		fill: currentColor;
	}

	.time {
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		flex: none;
	}

	.seek {
		flex: 1;
		min-width: 0;
		accent-color: var(--accent);
	}

	.mute,
	.save {
		display: inline-flex;
		align-items: center;
		padding: 0;
		border: none;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		flex: none;
	}

	.mute:hover,
	.save:hover:not(:disabled) {
		color: var(--text-primary);
	}

	.save:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.save-note {
		margin: 4px 0 0;
		font-size: 0.75rem;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.mute svg,
	.save svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.mute svg polygon {
		fill: currentColor;
	}

	.volume {
		width: 4.5rem;
		flex: none;
		accent-color: var(--accent);
	}

	audio {
		display: none;
	}
</style>
