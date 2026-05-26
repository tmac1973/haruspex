<script lang="ts">
	// Lightweight image viewer. Dismissable on backdrop click or Escape;
	// distinct from the confirmation Modal which deliberately resists
	// dismissal.

	import { onMount, onDestroy } from 'svelte';

	interface Props {
		src: string | null;
		alt?: string;
		onClose: () => void;
	}

	let { src, alt = 'image', onClose }: Props = $props();

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}

	onMount(() => {
		window.addEventListener('keydown', onKey);
	});
	onDestroy(() => {
		window.removeEventListener('keydown', onKey);
	});

	function onBackdropClick(e: MouseEvent) {
		// Only close when the actual backdrop is clicked, not the image.
		if (e.target === e.currentTarget) onClose();
	}
</script>

{#if src}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="viewer-backdrop" onclick={onBackdropClick}>
		<button class="close" onclick={onClose} aria-label="Close">×</button>
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
	.close {
		position: absolute;
		top: 16px;
		right: 16px;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		border: none;
		background: rgba(255, 255, 255, 0.15);
		color: white;
		font-size: 24px;
		line-height: 1;
		cursor: pointer;
	}
	.close:hover {
		background: rgba(255, 255, 255, 0.25);
	}
</style>
