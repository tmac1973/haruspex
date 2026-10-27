<script lang="ts">
	/**
	 * What a finished background song made, under its task card: the song in
	 * the player answers use, and where it was saved.
	 */
	import AudioPlayer from '#lib/components/AudioPlayer.svelte';
	import { songUrl, type MusicTaskResult } from '#lib/agent/tools/_musicJob.ts';
	import type { BackgroundTask } from '#lib/tasks/types.ts';

	let { task }: { task: BackgroundTask } = $props();

	const result = $derived(task.result as MusicTaskResult);
	const src = $derived(songUrl(result));
</script>

{#if src}
	<AudioPlayer {src} title={result.title} />
{/if}
{#if result.saved}
	<p class="detail">{result.saved}</p>
{/if}

<style>
	.detail {
		margin: 0;
		font-size: 0.85em;
		color: var(--text-muted, #888);
	}
</style>
