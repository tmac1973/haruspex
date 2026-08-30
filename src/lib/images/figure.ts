/**
 * Building the HTML for one displayed image.
 *
 * Kept out of `markdown.ts` so that module stays a pure text transform with no
 * knowledge of the cache, the URI scheme or the licence rules. `markdown.ts`
 * asks for a figure and gets a string or `null`; everything specific to images
 * lives here.
 */

import type { ImageRow } from '$lib/ipc/gen/ImageRow';
import type { ResolvedImages } from '$lib/markdown';
import { captionFor } from './caption';
import { getResolvedImages } from './resolve.svelte';
import { imageSrc } from './url';

/** Minimal HTML escape for text going into an attribute or text node. */
function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * The `<figure>` for one cached image, or `null` if it is not displayable.
 *
 * `null` is the common case, not an error: an image still being fetched, one
 * whose fetch failed, and one that was never eligible all land here, and all
 * three render as nothing.
 */
export function figureHtml(row: ImageRow, alt: string): string | null {
	const src = imageSrc(row.hash);
	// A hash that fails validation means the row is corrupt. Show nothing
	// rather than emitting a URL the protocol handler will refuse.
	if (!src) return null;

	const caption = captionFor(row);
	const captionHtml = caption
		? `<figcaption class="chat-image-credit">${esc(caption.text)}${
				caption.linkHref
					? `<a href="${esc(caption.linkHref)}" target="_blank" rel="noreferrer noopener">${esc(
							caption.linkLabel
						)}</a>`
					: esc(caption.linkLabel)
			}</figcaption>`
		: '';

	// width/height are set so the browser can reserve the right box before the
	// bytes arrive, which stops the text below jumping as each image lands.
	return (
		`<figure class="chat-image">` +
		`<img src="${esc(src)}" alt="${esc(alt)}" width="${row.width}" height="${row.height}" loading="lazy">` +
		captionHtml +
		`</figure>`
	);
}

/**
 * The live view over the resolved-image map, for `renderMarkdown`.
 *
 * Reading the map inside `figureFor` rather than snapshotting it is what makes
 * rendering reactive: the caller's `$derived` re-runs when the SvelteMap
 * changes, and images appear as each one resolves.
 */
export const resolvedImages: ResolvedImages = {
	figureFor(url: string, alt: string): string | null {
		const row = getResolvedImages().get(url);
		return row ? figureHtml(row, alt) : null;
	}
};
