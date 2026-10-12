/**
 * Resize a panel by dragging its edge, from the handle's `mousedown` until
 * the button comes up. The cursor stays `col-resize` and text selection is
 * off for the whole drag, even when the pointer leaves the handle.
 */
export function startDragResize(
	event: MouseEvent,
	opts: {
		/** The panel's width when the drag starts. */
		width: number;
		/** Which way the pointer moves to widen the panel: `right` for a panel
		 *  on the left whose handle is its right edge, `left` for one on the right. */
		widens: 'left' | 'right';
		clamp: (width: number) => number;
		/** Each move, with the clamped width. */
		onResize: (width: number) => void;
		/** On release, with the final width: persist it here. */
		onDone: (width: number) => void;
	}
): void {
	event.preventDefault();
	const startX = event.clientX;
	let width = opts.width;
	document.body.style.cursor = 'col-resize';
	document.body.style.userSelect = 'none';

	function onMove(e: MouseEvent) {
		const delta = opts.widens === 'right' ? e.clientX - startX : startX - e.clientX;
		width = opts.clamp(opts.width + delta);
		opts.onResize(width);
	}
	function onUp() {
		window.removeEventListener('mousemove', onMove);
		window.removeEventListener('mouseup', onUp);
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		opts.onDone(width);
	}
	window.addEventListener('mousemove', onMove);
	window.addEventListener('mouseup', onUp);
}
