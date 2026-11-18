/**
 * Images can't be dragged out of the window. On Linux, GTK 3 hands a drop
 * target the image by writing it into a pipe on the main thread, and a target
 * that stops reading (Discord does) freezes the whole app until it quits.
 * Copy or save the image instead. Revisit if Tauri moves to GTK 4, which
 * writes without blocking.
 *
 * One listener on the document, so it covers images in answers (plain HTML
 * from markdown) and in components alike, and a link wrapped around one.
 */
export function installImageDragBlock(doc: Document): () => void {
	const handler = (e: DragEvent) => {
		const t = e.target;
		if (t instanceof HTMLImageElement || (t instanceof Element && t.querySelector('img'))) {
			e.preventDefault();
		}
	};
	doc.addEventListener('dragstart', handler, true);
	return () => doc.removeEventListener('dragstart', handler, true);
}
