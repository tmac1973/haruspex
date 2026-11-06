<script lang="ts">
	/**
	 * An image in an editor window: fitted to the pane or at its real size,
	 * on a checkerboard so transparency shows. Read fresh on mount and on
	 * Reload; nothing here writes.
	 */
	import { onMount } from 'svelte';
	import { formatBytes } from '#lib/utils/format.ts';
	import { extOf, imageMime } from '#lib/utils/mime.ts';
	import { blobUrlOf, readViewerBytes, viewerError } from '#lib/editor/viewerFile.ts';

	let { workdir, relPath }: { workdir: string; relPath: string } = $props();

	let url = $state('');
	let bytes = $state(0);
	let width = $state(0);
	let height = $state(0);
	let error = $state('');
	let loading = $state(true);
	/** At its real size, scrolling when larger than the pane; otherwise fitted. */
	let actual = $state(false);
	let stage: HTMLDivElement | undefined = $state();
	/** Where the pointer was last, while dragging the image around at 1:1. */
	let drag = $state<{ x: number; y: number } | null>(null);

	function startPan(e: PointerEvent): void {
		if (!actual || e.button !== 0 || !stage) return;
		// A press on a scroll bar is the scroll bar's.
		const box = stage.getBoundingClientRect();
		if (e.clientX - box.left - stage.clientLeft >= stage.clientWidth) return;
		if (e.clientY - box.top - stage.clientTop >= stage.clientHeight) return;
		e.preventDefault();
		stage.setPointerCapture?.(e.pointerId);
		drag = { x: e.clientX, y: e.clientY };
	}

	function pan(e: PointerEvent): void {
		if (!drag || !stage) return;
		stage.scrollLeft -= e.clientX - drag.x;
		stage.scrollTop -= e.clientY - drag.y;
		drag = { x: e.clientX, y: e.clientY };
	}

	function endPan(): void {
		drag = null;
	}

	function release(): void {
		if (url) URL.revokeObjectURL(url);
		url = '';
	}

	async function load(): Promise<void> {
		loading = true;
		error = '';
		release();
		try {
			const data = await readViewerBytes(workdir, relPath);
			bytes = data.length;
			url = blobUrlOf(data, imageMime(extOf(relPath)) ?? '');
		} catch (e) {
			error = viewerError('show', relPath, e);
			loading = false;
		}
	}

	function loaded(e: Event): void {
		const img = e.currentTarget as HTMLImageElement;
		width = img.naturalWidth;
		height = img.naturalHeight;
		loading = false;
	}

	function failed(): void {
		error = `Could not show ${relPath}: not an image this viewer can read.`;
		loading = false;
	}

	onMount(() => {
		void load();
		return release;
	});

	const summary = $derived(
		width ? `${width} × ${height} px · ${formatBytes(bytes)}` : bytes ? formatBytes(bytes) : ''
	);
</script>

<div class="image-viewer" data-testid="image-viewer">
	<div
		class="stage"
		class:actual
		class:dragging={drag}
		role="presentation"
		bind:this={stage}
		onpointerdown={startPan}
		onpointermove={pan}
		onpointerup={endPan}
		onpointercancel={endPan}
	>
		{#if url && !error}
			<img src={url} alt={relPath} draggable="false" onload={loaded} onerror={failed} />
		{/if}
		{#if loading && !error}<p class="note">Loading…</p>{/if}
		{#if error}<p class="note error">{error}</p>{/if}
	</div>
	<div class="bar">
		<span class="summary">{summary}</span>
		<button
			disabled={!url || !!error}
			onclick={() => (actual = !actual)}
			title={actual ? 'Fit the image to the window' : 'Show the image at its real size'}
			>{actual ? 'Fit' : '1:1'}</button
		>
		<button disabled={loading} onclick={() => void load()}>Reload</button>
	</div>
</div>

<style>
	.image-viewer {
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
		display: grid;
		place-items: center;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 6px;
		background-color: #3a3a3a;
		background-image:
			linear-gradient(45deg, #444 25%, transparent 25%),
			linear-gradient(-45deg, #444 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, #444 75%),
			linear-gradient(-45deg, transparent 75%, #444 75%);
		background-size: 16px 16px;
		background-position:
			0 0,
			0 8px,
			8px -8px,
			-8px 0;
	}
	/* Fitted: shrunk to the pane when larger, never enlarged. */
	.stage img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: scale-down;
	}
	.stage.actual {
		overflow: auto;
		place-items: start;
		cursor: grab;
	}
	.stage.actual.dragging {
		cursor: grabbing;
	}
	.stage.actual img {
		position: static;
		width: auto;
		height: auto;
	}
	.note {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.85rem;
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
</style>
