<script lang="ts">
	/**
	 * A video with the controls and our own full-screen button: the frame
	 * around the video goes full screen, not the `<video>`, since WebKitGTK
	 * (2.54) draws a fullscreen `<video>` as black. WebKit ignores
	 * `controlslist`, so the button sits over its own in the top-left corner.
	 */
	interface Props {
		src: string;
		title: string;
		loop?: boolean;
		/** Fill the space it is given (a viewer tab) rather than a card's width. */
		fill?: boolean;
		onerror?: () => void;
		/** The `<video>`, for a caller that follows or moves the playhead. */
		video?: HTMLVideoElement;
	}

	let { src, title, loop = false, fill = false, onerror, video = $bindable() }: Props = $props();

	let frame = $state<HTMLDivElement | undefined>(undefined);
	let fullscreen = $state(false);

	function toggleFullscreen() {
		if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
		else void frame?.requestFullscreen().catch(() => {});
	}
</script>

<div
	class="frame"
	class:fill
	bind:this={frame}
	onfullscreenchange={() => (fullscreen = document.fullscreenElement === frame)}
>
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={video}
		{src}
		controls
		{loop}
		playsinline
		preload="metadata"
		aria-label={title}
		{onerror}
	></video>
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

<style>
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

	.frame.fill {
		flex: 1;
		min-height: 0;
		justify-content: center;
		background: #000;
		border-radius: 6px;
	}

	.frame.fill video {
		max-height: 100%;
		object-fit: contain;
	}
</style>
