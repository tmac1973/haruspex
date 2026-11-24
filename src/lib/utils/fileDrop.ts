/**
 * `use:fileDropTarget`: hand the paths of files dropped on an element to a
 * callback, any type. Like `imageDrop.ts` it listens to Tauri's native
 * drag-drop event (see there for why not the DOM `drop` event) and
 * hit-tests the drop against the element, so only the element under the
 * pointer takes it.
 */
import { getCurrentWebview } from '@tauri-apps/api/webview';

export interface FileDropOptions {
	/** The dropped files' paths, and where in the page (CSS pixels) they landed. */
	onFiles: (paths: string[], at: { x: number; y: number }) => void;
	/** A file drag entering or leaving the element (for a highlight). */
	onDragChange?: (over: boolean) => void;
	/** False ignores drops (a hidden tab). */
	enabled?: boolean;
}

/** Native drag positions are physical pixels; the DOM's are CSS pixels. */
export function toCss(phys: { x: number; y: number }, dpr: number): { x: number; y: number } {
	return { x: phys.x / dpr, y: phys.y / dpr };
}

/** Whether a CSS-pixel point is inside a rect with any size (a hidden one has none). */
export function isInside(p: { x: number; y: number }, r: DOMRect): boolean {
	return (
		r.width > 0 &&
		r.height > 0 &&
		p.x >= r.left &&
		p.x <= r.right &&
		p.y >= r.top &&
		p.y <= r.bottom
	);
}

export function fileDropTarget(node: HTMLElement, options: FileDropOptions) {
	let opts = options;
	let unlisten: (() => void) | null = null;
	let disposed = false;

	const at = (phys: { x: number; y: number }) => toCss(phys, window.devicePixelRatio || 1);
	const over = (phys: { x: number; y: number }) =>
		opts.enabled !== false && isInside(at(phys), node.getBoundingClientRect());

	try {
		void getCurrentWebview()
			.onDragDropEvent((event) => {
				if (disposed) return;
				const p = event.payload;
				if (p.type === 'over') opts.onDragChange?.(over(p.position));
				else if (p.type === 'leave') opts.onDragChange?.(false);
				else if (p.type === 'drop') {
					opts.onDragChange?.(false);
					if (over(p.position) && p.paths.length) opts.onFiles(p.paths, at(p.position));
				}
			})
			.then((un) => {
				if (disposed) un();
				else unlisten = un;
			})
			.catch((e) => console.warn('file drop unavailable', e));
	} catch (e) {
		console.warn('file drop unavailable', e);
	}

	return {
		update(next: FileDropOptions) {
			opts = next;
		},
		destroy() {
			disposed = true;
			unlisten?.();
		}
	};
}
