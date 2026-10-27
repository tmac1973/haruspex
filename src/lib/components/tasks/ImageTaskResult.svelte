<script lang="ts">
	/**
	 * What a finished background picture made, under its task card: the
	 * picture, which opens in the image viewer, and where it was saved.
	 */
	import { VIEW_IMAGE_EVENT } from '#lib/markdown-actions.ts';
	import { imageSrc } from '#lib/images/url.ts';
	import type { ImageTaskResult } from '#lib/agent/tools/_imageJob.ts';
	import type { BackgroundTask } from '#lib/tasks/types.ts';

	let { task }: { task: BackgroundTask } = $props();

	const result = $derived(task.result as ImageTaskResult);
	const src = $derived(imageSrc(result.hash));

	function view() {
		if (!src) return;
		document.dispatchEvent(new CustomEvent(VIEW_IMAGE_EVENT, { detail: { src, alt: result.alt } }));
	}
</script>

{#if src}
	<button class="thumb" type="button" title="Click to enlarge" onclick={view}>
		<img {src} alt={result.alt} width={result.width} height={result.height} />
	</button>
{/if}
<p class="detail">
	{result.width}×{result.height}{result.saved ? ` · ${result.saved}` : ''}
</p>

<style>
	.thumb {
		appearance: none;
		padding: 0;
		border: none;
		background: none;
		cursor: zoom-in;
		align-self: flex-start;
	}

	img {
		display: block;
		max-width: 240px;
		max-height: 240px;
		width: auto;
		height: auto;
		border-radius: 6px;
	}

	.detail {
		margin: 0;
		font-size: 0.85em;
		color: var(--text-muted, #888);
	}
</style>
