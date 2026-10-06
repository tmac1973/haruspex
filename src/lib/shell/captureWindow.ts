/**
 * The Shell tab's "capture a window" button: pick a window, screenshot it, and
 * send it to the assistant. Built for game testing — run the game, press the
 * button, click its window, and the assistant sees the frame.
 *
 * Picking is the platform's job where it has a picker. On Linux the desktop
 * portal shows its own, and the user clicks the window there, so the list is
 * empty and the capture goes straight to the portal. macOS and Windows have
 * none, so the sidebar lists the open windows instead — capturing "the focused
 * window" there would capture Haruspex, which is where the button was pressed.
 */

import { invoke } from '@tauri-apps/api/core';
import { IPC } from '$lib/ipc/commands';
import type { CaptureWindow } from '$lib/ipc/gen/CaptureWindow';
import type { ScreenCapture } from '$lib/ipc/gen/ScreenCapture';

/** What is sent with the picture when the composer is empty. */
export const CAPTURE_PROMPT =
	'Here is a screenshot of the window. Look at it and tell me what you see, ' +
	'and anything that looks wrong.';

/** Windows to choose from, or none when the platform picks for us (Linux). */
export function windowsToPick(): Promise<CaptureWindow[]> {
	return invoke<CaptureWindow[]>(IPC.list_capture_windows);
}

/**
 * A screenshot of the chosen window, as a JPEG data URL. `id` null asks the
 * platform's picker (the Linux portal).
 */
export async function captureWindowImage(id: number | null): Promise<string> {
	const capture =
		id === null
			? await invoke<ScreenCapture>(IPC.capture_screen, { target: 'window' })
			: await invoke<ScreenCapture>(IPC.capture_window, { id });
	return capture.dataUrl;
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
