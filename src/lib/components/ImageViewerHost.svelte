<script lang="ts">
	/**
	 * Mounted once in the root layout: answers `VIEW_IMAGE_EVENT` from any
	 * tab or modal with the shared viewer. The event's `gallery` is the
	 * pictures beside the clicked one, so a job's stills can be stepped
	 * through with ← and →.
	 */
	import { onMount } from 'svelte';
	import ImageViewerModal from '#lib/components/ImageViewerModal.svelte';
	import { VIEW_IMAGE_EVENT, type ViewImageDetail } from '#lib/markdownActions.ts';
	import {
		closeImageViewer,
		getImageViewer,
		openImageViewer,
		stepImageViewer
	} from '#lib/stores/imageViewer.svelte.ts';

	onMount(() => {
		const onView = (e: Event) => {
			const detail = (e as CustomEvent<ViewImageDetail>).detail;
			if (!detail?.src) return;
			const image = { src: detail.src, alt: detail.alt || 'image' };
			const gallery = detail.gallery?.length ? detail.gallery : [image];
			const at = gallery.findIndex((g) => g.src === image.src);
			openImageViewer(at < 0 ? [image] : gallery, Math.max(at, 0));
		};
		document.addEventListener(VIEW_IMAGE_EVENT, onView);
		return () => document.removeEventListener(VIEW_IMAGE_EVENT, onView);
	});

	const viewer = $derived(getImageViewer());
	const current = $derived(viewer ? viewer.images[viewer.index] : null);
	const many = $derived((viewer?.images.length ?? 0) > 1);
</script>

<ImageViewerModal
	src={current?.src ?? null}
	alt={current?.alt}
	onClose={closeImageViewer}
	position={many && viewer ? `${viewer.index + 1} of ${viewer.images.length}` : undefined}
	onStep={many ? stepImageViewer : undefined}
/>
