/**
 * Window capture for the composer's camera button (Window…), and the text the
 * Shell tab sends with a capture. Built for game testing — run the game, press
 * the button, click its window, and the assistant sees the frame.
 *
 * macOS and Windows list the open windows to pick from — capturing "the
 * focused window" there would capture Haruspex, which is where the button was
 * pressed. Linux lists none: on KDE Plasma the user clicks the window itself,
 * and elsewhere Window… becomes Region…, since a Wayland app cannot see where
 * other windows are.
 */

import { invoke } from '@tauri-apps/api/core';
import type { CaptureWindow } from '#lib/ipc/gen/CaptureWindow.ts';
import type { ScreenCapture } from '#lib/ipc/gen/ScreenCapture.ts';
import type { WindowClick } from '#lib/ipc/gen/WindowClick.ts';
import { regionFrameWhileHidden, withHaruspexHidden } from '#lib/shell/captureRegion.ts';

/** What is sent with the picture when the composer is empty. */
export const CAPTURE_PROMPT =
	'Here is a screenshot. Look at it and tell me what you see, and anything that looks wrong.';

/** Windows to choose from, or none where the user clicks one instead (Linux). */
export function windowsToPick(): Promise<CaptureWindow[]> {
	return invoke<CaptureWindow[]>('list_capture_windows');
}

/** A screenshot of the window picked from the list, as a JPEG data URL. */
export async function captureWindowImage(id: number): Promise<string> {
	const capture = await invoke<ScreenCapture>('capture_window', { id });
	return capture.dataUrl;
}

/** How Window… ended where there is no list: a picture, nothing, or a region to drag. */
export type ClickedWindow =
	| { kind: 'captured'; dataUrl: string }
	| { kind: 'cancelled' }
	| { kind: 'region'; preview: ScreenCapture };

/**
 * Hide Haruspex and let the user click the window to capture. Where the
 * desktop cannot do that, take the screen for a region instead, still hidden,
 * so the window does not flash back in between.
 */
export function clickWindow(): Promise<ClickedWindow> {
	return withHaruspexHidden(async (): Promise<ClickedWindow> => {
		const click = await invoke<WindowClick>('capture_window_click');
		if (click.kind === 'captured') return { kind: 'captured', dataUrl: click.capture.dataUrl };
		if (click.kind === 'cancelled') return click;
		return { kind: 'region', preview: await regionFrameWhileHidden() };
	});
}

/** The text sent with a capture: what the user typed, else the default ask. */
export function captureMessage(composerText: string): string {
	return composerText.trim() || CAPTURE_PROMPT;
}

/** How a window is named in the pick list. */
export function windowLabel(w: CaptureWindow): string {
	const title = w.title.trim();
	const app = w.app.trim();
	if (title && app && !title.includes(app)) return `${title} — ${app}`;
	return title || app;
}
