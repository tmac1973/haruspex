/**
 * Open one of the app's extra windows (an editor, a detached Code session or
 * Shell tab). Made in Rust (`app_windows.rs`), not with the JS
 * `WebviewWindow`: on Windows a webview has to start with the main window's
 * browser arguments, which only Rust can pass, or WebView2 refuses to make
 * it. Rejects with why the window couldn't open.
 */
import { invoke } from '@tauri-apps/api/core';

export interface AppWindowSpec {
	/** `editor-…`, `code-…` or `shell-…`. */
	label: string;
	/** An app route, such as `/editor?root=…`. */
	url: string;
	title: string;
	width: number;
	height: number;
	/** Where to put it; centred when left out. */
	x?: number;
	y?: number;
}

export async function openAppWindow(spec: AppWindowSpec): Promise<void> {
	await invoke('app_window_open', { spec: { ...spec, x: spec.x ?? null, y: spec.y ?? null } });
}
