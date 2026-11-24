/**
 * Delegated click handling for buttons inside rendered markdown.
 *
 * The markdown renderer emits raw HTML strings, so its buttons can't carry
 * Svelte handlers — and inline `onclick` attributes are stripped by the
 * sanitizer (and blocked by CSP). Instead the renderer tags each button with
 * a `data-action` attribute and this module routes clicks for all of them
 * via one document-level listener.
 */

import { copyText } from '#lib/utils/copyText.ts';
import { saveImageAs, saveWithToast } from '#lib/images/save.ts';

const codeFor = (btn: HTMLElement): string =>
	btn.closest('.code-block')?.querySelector('code')?.textContent ?? '';

/** Event `ImageViewerHost` listens for to open the full-size image viewer. */
export const VIEW_IMAGE_EVENT = 'hsp-view-image';

export interface ViewImageDetail {
	src: string;
	alt: string;
	/** Every enlargeable picture in the same rendered markdown, in order. */
	gallery?: { src: string; alt: string }[];
}

/** The pictures beside `zoom`: those in its markdown block, or none. */
function galleryOf(zoom: HTMLElement): ViewImageDetail['gallery'] {
	const block = zoom.closest('.markdown');
	if (!block) return undefined;
	return Array.from(block.querySelectorAll<HTMLImageElement>('[data-action="view-image"] img')).map(
		(img) => ({ src: img.src, alt: img.alt })
	);
}

export function handleMarkdownAction(event: MouseEvent): void {
	const target = event.target as HTMLElement | null;

	// Matched before the generic button lookup because it needs the <img>
	// inside the wrapper rather than the button itself. The image is wrapped
	// in a real <button> so it is keyboard-reachable and announced, rather
	// than being a bare <img> with a click handler.
	const zoom = target?.closest<HTMLElement>('[data-action="view-image"]');
	if (zoom) {
		const img = zoom.querySelector('img');
		if (img) {
			const detail: ViewImageDetail = { src: img.src, alt: img.alt, gallery: galleryOf(zoom) };
			document.dispatchEvent(new CustomEvent(VIEW_IMAGE_EVENT, { detail }));
		}
		return;
	}

	const btn = target?.closest<HTMLElement>('button[data-action]');
	if (!btn) return;
	switch (btn.dataset.action) {
		case 'copy':
			void copyText(codeFor(btn)).catch(() => {});
			break;
		case 'shell-paste':
			document.dispatchEvent(new CustomEvent('hsp-shell-paste', { detail: codeFor(btn) }));
			break;
		case 'shell-run':
			document.dispatchEvent(new CustomEvent('hsp-shell-run', { detail: codeFor(btn) }));
			break;
		case 'notebook-open': {
			const id = btn.dataset.notebook;
			const card = btn.dataset.card;
			if (id)
				void import('#lib/notebooks/openLink.ts')
					.then((m) => m.openNotebookLink(id, card))
					.catch((e) => console.warn('Could not open the notebook:', e));
			break;
		}
		case 'save-image': {
			const hash = btn.dataset.hash;
			const alt = btn.closest('.image-frame')?.querySelector('img')?.alt ?? '';
			if (hash) void saveWithToast(() => saveImageAs(hash, alt));
			break;
		}
	}
}

/** Install the listener; returns the teardown for onDestroy. */
export function installMarkdownActions(): () => void {
	document.addEventListener('click', handleMarkdownAction);
	return () => document.removeEventListener('click', handleMarkdownAction);
}
