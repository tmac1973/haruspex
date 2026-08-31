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
import type { SearchStep } from '$lib/agent/loop';
import { captionFor } from './caption';
import { imageUrlsInText, stripCandidates } from './eligible';
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
	//
	// `data-action` rather than an inline handler: this HTML goes through
	// DOMPurify, which strips `onclick`, and the CSP would block it anyway.
	// markdown-actions.ts routes the click, the same way the code-block
	// copy/paste/run buttons work.
	return (
		`<figure class="chat-image">` +
		`<button type="button" class="chat-image-zoom" data-action="view-image" ` +
		`title="Click to enlarge" aria-label="Enlarge image">` +
		`<img src="${esc(src)}" alt="${esc(alt)}" width="${row.width}" height="${row.height}" ` +
		`loading="lazy">` +
		`</button>` +
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

/**
 * The images to show beneath one answer, or an empty list.
 *
 * Returns candidates only when the answer embedded no image of its own: an
 * inline picture placed next to the paragraph it illustrates is the better
 * outcome and this must not duplicate it. The strip exists purely to catch the
 * case where the model searched and then forgot to write the markdown.
 *
 * Unresolved candidates are omitted rather than held as placeholders, so a
 * strip whose images all failed to fetch renders as nothing at all — the same
 * silent behaviour as an unresolved inline image.
 */
export function stripFor(text: string, steps: readonly SearchStep[]): ImageRow[] {
	const map = getResolvedImages();

	// Something already rendered in the prose — leave the answer alone.
	const embedded = imageUrlsInText([text]).some((url) => map.has(url));
	if (embedded) return [];

	return stripCandidates(steps)
		.map((c) => map.get(c.url))
		.filter((row): row is ImageRow => row !== undefined);
}
