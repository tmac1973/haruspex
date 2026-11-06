<script lang="ts" module>
	/**
	 * Kept across files, so stepping through a folder of sounds keeps playing:
	 * true from Play until Pause. A sound that ends still counts, so → plays
	 * the next sound effect. Set as it happens, not on unmount, since the next
	 * file's viewer mounts before this one goes.
	 */
	let wasPlaying = false;
	let loopOn = false;
</script>

<script lang="ts">
	/**
	 * A sound in an editor window: its waveform, to click to a point, and the
	 * app's own player (`AudioPlayer`; WebKitGTK doesn't repaint the native
	 * controls). Read fresh on mount and on Reload; nothing here writes.
	 */
	import { onMount, tick } from 'svelte';
	import AudioPlayer from '#lib/components/AudioPlayer.svelte';
	import { clock, peaks } from '#lib/editor/waveform.ts';
	import { blobUrlOf, readViewerBytes, viewerError } from '#lib/editor/viewerFile.ts';
	import { formatBytes } from '#lib/utils/format.ts';
	import { extOf } from '#lib/utils/mime.ts';

	let { workdir, relPath }: { workdir: string; relPath: string } = $props();

	const MIME: Record<string, string> = {
		wav: 'audio/wav',
		mp3: 'audio/mpeg',
		ogg: 'audio/ogg',
		oga: 'audio/ogg',
		opus: 'audio/ogg',
		flac: 'audio/flac',
		m4a: 'audio/mp4',
		aac: 'audio/aac'
	};
	const BUCKETS = 600;

	const startPlaying = wasPlaying;
	let url = $state('');
	let bytes = $state(0);
	let error = $state('');
	let loading = $state(true);
	let info = $state<{ duration: number; channels: number } | null>(null);
	let wave = $state.raw<number[]>([]);
	/** How far through, 0 to 1. */
	let position = $state(0);
	let loop = $state(loopOn);
	let box: HTMLElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();
	let audio: HTMLAudioElement | null = null;
	let gone = false;
	const name = $derived(relPath.split('/').pop() ?? relPath);

	function release(): void {
		if (url) URL.revokeObjectURL(url);
		url = '';
	}

	async function load(): Promise<void> {
		loading = true;
		error = '';
		info = null;
		wave = [];
		position = 0;
		release();
		try {
			const data = await readViewerBytes(workdir, relPath);
			bytes = data.length;
			url = blobUrlOf(data, MIME[extOf(relPath)] ?? '');
			await tick();
			watch();
			await outline(data);
		} catch (e) {
			error = viewerError('play', relPath, e);
		}
		loading = false;
	}

	/** The waveform and the facts, when the webview can decode the file; none otherwise. */
	async function outline(data: Uint8Array): Promise<void> {
		if (typeof AudioContext === 'undefined') return;
		const ctx = new AudioContext();
		try {
			const buf = await ctx.decodeAudioData(data.slice().buffer);
			const channels = Array.from({ length: buf.numberOfChannels }, (_, i) =>
				buf.getChannelData(i)
			);
			// Not its sample rate: decoding resamples to the context's.
			info = { duration: buf.duration, channels: buf.numberOfChannels };
			wave = peaks(channels, BUCKETS);
		} catch (e) {
			console.warn('Decoding audio for its waveform failed', e);
		} finally {
			void ctx.close().catch(() => {});
		}
	}

	/** Follow the player's element: where it is, and whether it can play at all. */
	function watch(): void {
		audio = box?.querySelector('audio') ?? null;
		if (!audio) return;
		audio.addEventListener('timeupdate', () => {
			if (audio && audio.duration > 0) position = audio.currentTime / audio.duration;
		});
		audio.addEventListener('play', () => (wasPlaying = true));
		audio.addEventListener('pause', () => {
			// Leaving the page pauses it too; that isn't the user's Pause.
			if (!gone && !audio?.ended) wasPlaying = false;
		});
		audio.addEventListener('error', () => {
			error = `Could not play ${relPath}: this system has no decoder for it.`;
		});
	}

	function draw(): void {
		if (!canvas) return;
		const dpr = window.devicePixelRatio || 1;
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		canvas.width = Math.max(1, Math.round(w * dpr));
		canvas.height = Math.max(1, Math.round(h * dpr));
		const g = canvas.getContext('2d');
		if (!g) return;
		g.scale(dpr, dpr);
		g.clearRect(0, 0, w, h);
		g.fillStyle = getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#2dd4bf';
		const step = w / Math.max(1, wave.length);
		for (let i = 0; i < wave.length; i++) {
			const bar = Math.max(1, wave[i] * (h - 4));
			g.fillRect(i * step, (h - bar) / 2, Math.max(1, step - 0.5), bar);
		}
	}

	$effect(() => {
		void wave;
		draw();
	});

	function seek(e: MouseEvent): void {
		if (!audio || !canvas || !(audio.duration > 0)) return;
		const r = canvas.getBoundingClientRect();
		audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
	}

	function setLoop(on: boolean): void {
		loop = on;
		loopOn = on;
	}

	onMount(() => {
		void load();
		const observer = new ResizeObserver(() => draw());
		if (canvas) observer.observe(canvas);
		return () => {
			gone = true;
			observer.disconnect();
			release();
		};
	});

	const summary = $derived(
		[
			info ? clock(info.duration) : '',
			info
				? info.channels === 1
					? 'mono'
					: info.channels === 2
						? 'stereo'
						: `${info.channels} channels`
				: '',
			bytes ? formatBytes(bytes) : ''
		]
			.filter(Boolean)
			.join(' · ')
	);
</script>

<div class="audio-viewer" data-testid="audio-viewer" bind:this={box}>
	<div class="stage">
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div
			class="wave"
			class:empty={wave.length === 0}
			onclick={seek}
			title="Click to play from there"
		>
			<canvas bind:this={canvas}></canvas>
			{#if wave.length}<div class="played" style="width: {position * 100}%"></div>{/if}
		</div>
		{#if url && !error}
			<div class="player">
				<AudioPlayer src={url} title={name} autoplay={startPlaying} {loop} />
			</div>
		{/if}
		{#if loading && !error}<p class="note">Loading…</p>{/if}
		{#if error}<p class="note error">{error}</p>{/if}
	</div>
	<div class="bar">
		<span class="summary">{summary}</span>
		<label title="Play it over and over">
			<input type="checkbox" checked={loop} onchange={(e) => setLoop(e.currentTarget.checked)} />
			Loop
		</label>
		<button disabled={loading} onclick={() => void load()}>Reload</button>
	</div>
</div>

<style>
	.audio-viewer {
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
		justify-content: center;
		align-items: center;
		gap: 16px;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	.wave {
		position: relative;
		width: 100%;
		height: 160px;
		cursor: pointer;
	}
	.wave.empty {
		visibility: hidden;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
	.played {
		position: absolute;
		inset: 0 auto 0 0;
		background: color-mix(in srgb, var(--text-primary) 18%, transparent);
		border-right: 2px solid var(--text-primary);
		pointer-events: none;
	}
	.player {
		width: 100%;
		max-width: 28rem;
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
	}
	.note.error {
		color: var(--danger, #ef4444);
		padding: 16px;
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
	label {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.8rem;
		color: var(--text-secondary);
		cursor: pointer;
	}
</style>
