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
	import { audioHashFromUrl } from '#lib/audio/url.ts';
	import { playableUrl } from '#lib/audio/playable.ts';

	interface Props {
		src: string;
		title: string;
	}
	let { src, title }: Props = $props();

	let loaded = $state<string | undefined>(undefined);
	let missing = $state(false);
	$effect(() => {
		const hash = audioHashFromUrl(src);
		loaded = undefined;
		missing = false;
		if (!hash) {
			loaded = src;
			return;
		}
		playableUrl(hash)
			.then((url) => (loaded = url))
			.catch(() => (missing = true));
	});

	let audio = $state<HTMLAudioElement | undefined>(undefined);
	let currentTime = $state(0);
	let duration = $state(0);
	let paused = $state(true);

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
	</div>
	<audio
		bind:this={audio}
		bind:currentTime
		bind:paused
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

	audio {
		display: none;
	}
</style>
