<script lang="ts">
	/**
	 * What a finished generated clip made, under its task card: the clip in
	 * the player answers use, its size and length, and where it was saved.
	 */
	import VideoPlayer from '#lib/components/VideoPlayer.svelte';
	import { clipSeconds, clipUrl, type VideoTaskResult } from '#lib/agent/tools/_videoJob.ts';
	import type { BackgroundTask } from '#lib/tasks/types.ts';

	let { task }: { task: BackgroundTask } = $props();

	const result = $derived(task.result as VideoTaskResult);
	const src = $derived(clipUrl(result));
</script>

{#if src}
	<VideoPlayer {src} title={result.title} />
{/if}
<p class="detail">
	{result.width}×{result.height} · {clipSeconds(result.frames, result.fps)} s{result.saved
		? ` · ${result.saved}`
		: ''}
</p>

<style>
	.detail {
		margin: 0;
		font-size: 0.85em;
		color: var(--text-muted, #888);
	}
</style>
