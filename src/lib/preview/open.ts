/**
 * Code preview windows: one per session, `preview-<sessionId>` on
 * `/preview`, showing an `.html` file from the session's folder as Rust's
 * preview server serves it on 127.0.0.1 (`src-tauri/src/preview/`). The
 * server checks the path; this opens the window, or points the open one at
 * the new page.
 */
import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openAppWindow } from '#lib/appWindow.ts';
import type { PreviewServe } from '#lib/ipc/gen/PreviewServe.ts';

/** Main → an open preview window: show this page instead. */
export const PREVIEW_NAVIGATE_EVENT = 'preview://navigate';
/** Rust → a preview window: a file the page loaded changed. */
export const PREVIEW_CHANGED_EVENT = 'preview://changed';

export interface PreviewNavigate {
	url: string;
	path: string;
}

export function previewLabel(sessionId: string): string {
	return `preview-${sessionId}`;
}

export function previewTitle(path: string): string {
	return `Preview — ${path}`;
}

/** The `/preview` route for a window that opens on `url`. */
export function previewRoute(sessionId: string, url: string, path: string): string {
	const q = new URLSearchParams({ session: sessionId, url, path });
	return `/preview?${q.toString()}`;
}

/**
 * Show `path` (relative to `root`) in the session's preview window, opening
 * it if need be. Resolves to the page's address; rejects with the server's
 * reason (outside the folder, missing, not HTML) or the window's.
 */
export async function openPreview(sessionId: string, root: string, path: string): Promise<string> {
	const { url } = await invoke<PreviewServe>('preview_serve', { sessionId, root, path });
	const label = previewLabel(sessionId);
	const open = await WebviewWindow.getByLabel(label).catch(() => null);
	if (open) {
		await emitTo(label, PREVIEW_NAVIGATE_EVENT, { url, path } satisfies PreviewNavigate);
		await open.unminimize().catch(() => {});
		await open.setFocus().catch(() => {});
		return url;
	}
	await openAppWindow({
		label,
		url: previewRoute(sessionId, url, path),
		title: previewTitle(path),
		width: 1100,
		height: 800
	});
	return url;
}

/**
 * `url` with a fresh cache-buster, so setting an iframe's `src` to it loads
 * the page again: a parent can't call `location.reload()` on a frame from
 * another origin.
 */
export function reloadUrl(url: string, n: number): string {
	const u = new URL(url);
	u.searchParams.delete('_r');
	u.searchParams.set('_r', String(n));
	return u.toString();
}
