<script lang="ts">
	/**
	 * A screenshot laid over the window to drag a rectangle on. Releasing the
	 * drag attaches it; Esc or the backdrop cancels. The preview
	 * is downscaled, so the rectangle is handed back in the frame's own pixels
	 * for Rust to crop the original.
	 */
	import type { CaptureRect } from '#lib/ipc/gen/CaptureRect.ts';
	import type { ScreenCapture } from '#lib/ipc/gen/ScreenCapture.ts';
	import { sourceRect, type Drag } from '#lib/shell/captureRegion.ts';
	import { onMount } from 'svelte';

	let {
		preview,
		onDone
	}: {
		preview: ScreenCapture;
		/** The selected region, or null when the user cancelled. */
		onDone: (rect: CaptureRect | null) => void;
	} = $props();

	let frame = $state<HTMLDivElement>();
	let drag = $state<Drag | null>(null);
	let dragging = $state(false);

	function point(e: PointerEvent) {
		const box = frame!.getBoundingClientRect();
		return { x: e.clientX - box.left, y: e.clientY - box.top };
	}

	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		const p = point(e);
		drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
		dragging = true;
		frame!.setPointerCapture(e.pointerId);
	}

	function move(e: PointerEvent) {
		if (!dragging || !drag) return;
		const p = point(e);
		drag = { ...drag, x1: p.x, y1: p.y };
	}

	function up() {
		if (!dragging) return;
		dragging = false;
		const rect = selected();
		if (rect) onDone(rect);
		else drag = null;
	}

	function selected(): CaptureRect | null {
		if (!drag || !frame) return null;
		const box = frame.getBoundingClientRect();
		return sourceRect(drag, { width: box.width, height: box.height }, preview);
	}

	function keydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onDone(null);
		}
	}

	/** The drag as CSS for the outline, clamped to the picture. */
	let box = $derived.by(() => {
		if (!drag || !frame) return null;
		const { width, height } = frame.getBoundingClientRect();
		const left = Math.max(0, Math.min(drag.x0, drag.x1));
		const top = Math.max(0, Math.min(drag.y0, drag.y1));
		const right = Math.min(width, Math.max(drag.x0, drag.x1));
		const bottom = Math.min(height, Math.max(drag.y0, drag.y1));
		return `left:${left}px;top:${top}px;width:${Math.max(0, right - left)}px;height:${Math.max(0, bottom - top)}px`;
	});

	onMount(() => frame?.focus());
</script>

<svelte:window onkeydown={keydown} />

<div class="region-overlay" role="dialog" aria-modal="true" aria-label="Select a region">
	<button class="backdrop" aria-label="Cancel" onclick={() => onDone(null)}></button>
	<p class="hint">Drag to select a region. Esc cancels.</p>
	<div
		class="frame"
		bind:this={frame}
		tabindex="-1"
		role="application"
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={() => ((dragging = false), (drag = null))}
	>
		<img src={preview.dataUrl} alt="Your screen" draggable="false" />
		{#if box}
			<div class="selection" style={box}></div>
		{/if}
	</div>
</div>

<style>
	.region-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 16px;
	}

	.backdrop {
		position: absolute;
		inset: 0;
		border: none;
		background: rgba(0, 0, 0, 0.75);
		cursor: default;
	}

	.hint {
		position: relative;
		margin: 0;
		font-size: 0.85rem;
		color: #fff;
	}

	.frame {
		position: relative;
		display: inline-block;
		max-width: 100%;
		max-height: calc(100% - 32px);
		cursor: crosshair;
		user-select: none;
		touch-action: none;
		outline: none;
		overflow: hidden;
		line-height: 0;
	}

	.frame img {
		display: block;
		max-width: 100%;
		max-height: calc(100vh - 80px);
		pointer-events: none;
	}

	.selection {
		position: absolute;
		border: 2px solid var(--accent, #4a9eff);
		box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
		pointer-events: none;
	}
</style>
