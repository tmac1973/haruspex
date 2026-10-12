/**
 * The composer's "Region" capture: hide Haruspex, take the screen, let the
 * user drag a rectangle over a preview, and crop the full-resolution frame
 * to it. The frame stays in Rust between the two calls; the page only ever
 * sees the downscaled preview and the cropped result.
 */

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { CaptureRect } from '#lib/ipc/gen/CaptureRect.ts';
import type { ScreenCapture } from '#lib/ipc/gen/ScreenCapture.ts';

/**
 * How long to wait after hiding the window before reading the screen. The
 * compositor repaints what was behind it asynchronously, and a capture taken
 * at once still shows Haruspex fading out.
 */
const HIDE_SETTLE_MS = 250;

/** A drag on the preview, in its displayed CSS pixels. */
export interface Drag {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Smaller than this on either side is a click, not a selection. */
export const MIN_DRAG_PX = 4;

/**
 * The drag as a rectangle of the captured frame. `shown` is the preview's
 * displayed size; `source` the frame's own. The drag may run past the
 * preview's edges, and either corner may be the one it started from.
 */
export function sourceRect(
	drag: Drag,
	shown: { width: number; height: number },
	source: { width: number; height: number }
): CaptureRect | null {
	const clampX = (v: number) => Math.min(Math.max(v, 0), shown.width);
	const clampY = (v: number) => Math.min(Math.max(v, 0), shown.height);
	const left = clampX(Math.min(drag.x0, drag.x1));
	const right = clampX(Math.max(drag.x0, drag.x1));
	const top = clampY(Math.min(drag.y0, drag.y1));
	const bottom = clampY(Math.max(drag.y0, drag.y1));
	if (right - left < MIN_DRAG_PX || bottom - top < MIN_DRAG_PX) return null;
	if (shown.width <= 0 || shown.height <= 0) return null;
	const sx = source.width / shown.width;
	const sy = source.height / shown.height;
	const x = Math.round(left * sx);
	const y = Math.round(top * sy);
	return {
		x,
		y,
		width: Math.min(Math.round(right * sx), source.width) - x,
		height: Math.min(Math.round(bottom * sy), source.height) - y
	};
}

/**
 * Take the screen with Haruspex out of the way, and return the preview to
 * select on. The window comes back whether or not the capture worked.
 */
export async function startRegionCapture(): Promise<ScreenCapture> {
	const win = getCurrentWindow();
	await win.hide();
	try {
		await new Promise((resolve) => setTimeout(resolve, HIDE_SETTLE_MS));
		return await invoke<ScreenCapture>('capture_region_start');
	} finally {
		await win.show();
		await win.setFocus();
	}
}

/** Crop to `rect` and return the JPEG data URL, or discard the frame (null). */
export async function finishRegionCapture(rect: CaptureRect | null): Promise<string | null> {
	const capture = await invoke<ScreenCapture | null>('capture_region_finish', { rect });
	return capture?.dataUrl ?? null;
}
