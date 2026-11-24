<script lang="ts">
	/** An image card: a picture kept with the notebook, shown inline; click to enlarge. */
	import * as api from '#lib/notebooks/api.ts';
	import { fileMeta, saveFileCopy } from '#lib/notebooks/files.ts';
	import { openImageViewer } from '#lib/stores/imageViewer.svelte.ts';
	import type { CardViewProps } from '#lib/notebooks/cardKinds.ts';

	let { card }: CardViewProps = $props();

	const file = $derived(fileMeta(card));
	const src = $derived(file ? api.fileUrl(file.hash) : '');
	const alt = $derived(card.title || file?.name || 'Picture');
</script>

{#if file && src}
	<button class="pic" onclick={() => openImageViewer([{ src, alt }])} title="View full size">
		<img {src} {alt} loading="lazy" />
	</button>
	<div class="actions">
		<button class="mini" onclick={() => void saveFileCopy(file)}>Save a copy…</button>
	</div>
{:else}
	<p class="missing">This picture's details are missing.</p>
{/if}

<style>
	.pic {
		display: block;
		padding: 0;
		border: none;
		background: none;
		cursor: zoom-in;
		max-width: 100%;
	}

	img {
		display: block;
		max-width: 100%;
		max-height: 480px;
		border-radius: 6px;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}

	.mini {
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.8rem;
		padding: 2px 4px;
	}

	.mini:hover {
		color: var(--accent);
	}

	.missing {
		color: var(--text-muted);
		font-size: 0.85rem;
	}
</style>
