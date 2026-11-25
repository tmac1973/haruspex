// Within this many pixels of a scroller's edge, a drag scrolls it.
const EDGE = 60;
// Pixels per frame at the very edge.
const MAX_SPEED = 18;

/**
 * How far to scroll this frame for a pointer at `y` in a scroller spanning
 * `top`..`bottom`: negative near the top, positive near the bottom, faster
 * closer to (or past) the edge, zero in the middle.
 */
export function edgeSpeed(y: number, top: number, bottom: number): number {
	const edge = Math.min(EDGE, (bottom - top) / 4);
	if (edge <= 0) return 0;
	if (y < top + edge) return -Math.ceil(MAX_SPEED * Math.min(1, (top + edge - y) / edge));
	if (y > bottom - edge) return Math.ceil(MAX_SPEED * Math.min(1, (y - (bottom - edge)) / edge));
	return 0;
}

/** The nearest ancestor of `node` that scrolls vertically, else the page. */
export function scrollParent(node: HTMLElement): HTMLElement {
	for (let el = node.parentElement; el; el = el.parentElement) {
		const { overflowY } = getComputedStyle(el);
		if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight)
			return el;
	}
	return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/**
 * Scroll the scroller around `node` while an HTML drag holds the pointer
 * near its top or bottom edge, so an item can be dragged past what fits on
 * screen (the wheel does nothing mid-drag). Call the returned function when
 * the drag ends.
 */
export function startDragAutoScroll(node: HTMLElement): () => void {
	const scroller = scrollParent(node);
	let y: number | null = null;
	let frame = 0;

	const onDragOver = (e: DragEvent) => {
		y = e.clientY;
	};
	const step = () => {
		if (y !== null) {
			const isPage = scroller === document.scrollingElement;
			const r = isPage ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
			const dy = edgeSpeed(y, r.top, r.bottom);
			if (dy) scroller.scrollTop += dy;
		}
		frame = requestAnimationFrame(step);
	};

	document.addEventListener('dragover', onDragOver);
	frame = requestAnimationFrame(step);
	return () => {
		document.removeEventListener('dragover', onDragOver);
		cancelAnimationFrame(frame);
	};
}
