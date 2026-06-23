/**
 * Svelte action that lets a composer accept dropped image files via Tauri's
 * NATIVE drag-drop event rather than the DOM `drop` event.
 *
 * Why native: with Tauri's native file-drop handler enabled (the default), the
 * webview can never navigate to a dropped file — Tauri intercepts the OS drop
 * before the webview sees it. Relying on the DOM `drop` event (which requires
 * disabling native handling) is fragile on WebKitGTK: an unprevented drop
 * navigates the window to the file:// URL and blanks the app. So we keep native
 * handling on and read the dropped file PATHS from `onDragDropEvent`.
 *
 * The native event is window-global, so each mounted composer hit-tests the
 * drop position against its own bounding rect and only the one under the cursor
 * attaches. Paths are read + resized by the `read_dropped_image` Rust command.
 */

import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invoke } from '@tauri-apps/api/core';

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export interface ImageDropOptions {
	/** Called with resized image data URLs when image files are dropped on the node. */
	onImages: (dataUrls: string[]) => void;
	/** Called as a file drag enters/leaves the node's bounds (drives the highlight). */
	onDragChange?: (over: boolean) => void;
}

export function imageDropTarget(node: HTMLElement, options: ImageDropOptions) {
	let opts = options;
	let unlisten: (() => void) | null = null;
	let disposed = false;

	/** Native drag positions are physical pixels; the DOM rect is CSS pixels. */
	function isOverNode(physX: number, physY: number): boolean {
		const dpr = window.devicePixelRatio || 1;
		const x = physX / dpr;
		const y = physY / dpr;
		const r = node.getBoundingClientRect();
		return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
	}

	async function attach(paths: string[]) {
		const images = paths.filter((p) => IMAGE_EXT_RE.test(p));
		if (!images.length) return;
		const urls: string[] = [];
		for (const path of images) {
			try {
				urls.push(await invoke<string>('read_dropped_image', { path }));
			} catch (e) {
				console.error('read_dropped_image failed', path, e);
			}
		}
		if (urls.length) opts.onImages(urls);
	}

	// getCurrentWebview()/onDragDropEvent only exist inside the Tauri webview;
	// guard so browser dev mode (and tests) don't throw.
	try {
		getCurrentWebview()
			.onDragDropEvent((event) => {
				if (disposed) return;
				const p = event.payload;
				if (p.type === 'over') {
					opts.onDragChange?.(isOverNode(p.position.x, p.position.y));
				} else if (p.type === 'leave') {
					opts.onDragChange?.(false);
				} else if (p.type === 'drop') {
					opts.onDragChange?.(false);
					if (isOverNode(p.position.x, p.position.y)) void attach(p.paths);
				}
			})
			.then((un) => {
				if (disposed) un();
				else unlisten = un;
			})
			.catch((e) => console.error('onDragDropEvent subscribe failed', e));
	} catch (e) {
		console.error('drag-drop unavailable', e);
	}

	return {
		update(next: ImageDropOptions) {
			opts = next;
		},
		destroy() {
			disposed = true;
			unlisten?.();
		}
	};
}
