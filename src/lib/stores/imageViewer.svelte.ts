/**
 * The one full-size image viewer, for every window. Anything that wants a
 * picture enlarged raises `VIEW_IMAGE_EVENT` (see `markdownActions.ts`);
 * `ImageViewerHost` in the root layout opens it here. It used to live in the
 * Chat tab, so a picture clicked anywhere else (a job's question, the Jobs
 * tab's run view) opened nothing.
 */

export interface ViewerImage {
	src: string;
	alt: string;
}

interface Open {
	images: ViewerImage[];
	index: number;
}

let open = $state.raw<Open | null>(null);

/** Show `images[index]`, with the others a step away. */
export function openImageViewer(images: ViewerImage[], index = 0): void {
	if (images.length === 0) return;
	open = { images, index: Math.min(Math.max(index, 0), images.length - 1) };
}

export function closeImageViewer(): void {
	open = null;
}

/** Move by `by` pictures, wrapping at the ends. */
export function stepImageViewer(by: number): void {
	if (!open) return;
	const n = open.images.length;
	open = { ...open, index: (((open.index + by) % n) + n) % n };
}

export function getImageViewer(): Open | null {
	return open;
}

/** Whether the viewer is up, so a modal under it leaves Escape to it. */
export function isImageViewerOpen(): boolean {
	return open !== null;
}
