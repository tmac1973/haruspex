<script lang="ts">
	/**
	 * A compact player for generated audio on a tool step card. Answers get
	 * the same native player from markdown (`audio/figure.ts`); this one adds
	 * the title above it. One plays at a time: see `audio/exclusive.ts`.
	 */
	interface Props {
		src: string;
		title: string;
	}
	let { src, title }: Props = $props();
</script>

<figure class="audio-player">
	{#if title}<figcaption>{title}</figcaption>{/if}
	<audio controls preload="metadata" {src}></audio>
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
