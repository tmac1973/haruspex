<script lang="ts">
	// Lightweight image viewer. Dismissable on backdrop click or Escape;
	// distinct from the confirmation Modal which deliberately resists
	// dismissal.

	import { dismissable } from '$lib/actions/dismissable';

	interface Props {
		src: string | null;
		alt?: string;
		onClose: () => void;
	}

	let { src, alt = 'image', onClose }: Props = $props();
</script>

{#if src}
	<div class="viewer-backdrop" use:dismissable={onClose}>
		<button class="modal-close viewer-close" onclick={onClose} aria-label="Close">×</button>
		<img class="viewer-img" {src} {alt} />
	</div>
{/if}

<style>
	.viewer-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.85);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2000;
		cursor: zoom-out;
	}
	.viewer-img {
		max-width: 90vw;
		max-height: 90vh;
		object-fit: contain;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.6);
		cursor: default;
		background: white;
	}
	/* Overrides of the global .modal-close: floats over a near-black
	   backdrop, so it needs its own white-on-dark circular look. */
	.viewer-close {
		position: absolute;
		top: 16px;
		right: 16px;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.15);
		color: white;
		font-size: 24px;
	}
	.viewer-close:hover {
		color: white;
		background: rgba(255, 255, 255, 0.25);
	}
</style>
