<script lang="ts">
	/**
	 * A compact player for generated audio on a tool step card. Answers get
	 * the same native player from markdown (`audio/figure.ts`); this one adds
	 * the title above it. One plays at a time: see `audio/exclusive.ts`.
	 *
	 * `src` is the cache's URL; the player loads it through `playableUrl`,
	 * since the desktop webview can't play the cache's own scheme.
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
</script>

<figure class="audio-player">
	{#if title}<figcaption>{title}</figcaption>{/if}
	<audio
		controls
		preload="metadata"
		src={loaded}
		title={missing ? 'This song is no longer in the audio cache.' : undefined}
	></audio>
</figure>

<style>
	.audio-player {
		margin: 6px 0 0;
	}

	figcaption {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin-bottom: 4px;
	}

	audio {
		display: block;
		width: 100%;
		max-width: 28rem;
	}
</style>
