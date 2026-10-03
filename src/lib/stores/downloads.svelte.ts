/**
 * The model download in progress, for every screen that shows one.
 *
 * Downloads run in Rust and outlive the screen that started them. When their
 * state lived in that screen, closing Settings mid-download forgot it: on
 * reopening the row offered Download again, with no progress, and a second
 * click started a second download of the same file that corrupted the first.
 * Here the state is module-level, so it survives a screen closing, and
 * `syncDownloads` asks Rust on opening — which also covers a reloaded webview.
 *
 * Rust allows one download at a time (`ModelManager::begin_download`), so
 * there is one `active` entry and the shared `download-progress` events
 * belong to it. Keys: `llm:<id>`, `image:<id>`, `comfy:<family>`.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DownloadProgress } from '$lib/ipc/gen/DownloadProgress';

export interface ActiveDownload {
	key: string;
	progress: DownloadProgress | null;
}

let active = $state<ActiveDownload | null>(null);
/** True while a download this webview started is still awaited. */
let awaited = false;
let listening: Promise<void> | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

/** What `download_status` says is downloading: a key, or nothing. */
async function runningKey(): Promise<string | null> {
	const key = await invoke<unknown>('download_status').catch(() => null);
	return typeof key === 'string' && key ? key : null;
}

function ensureListening(): Promise<void> {
	listening ??= listen<DownloadProgress>('download-progress', (e) => {
		if (active) active.progress = e.payload;
	}).then(
		() => undefined,
		(e) => {
			listening = null; // try again next time
			throw e;
		}
	);
	return listening;
}

/** The download in progress, or null. Reactive. */
export function getActiveDownload(): ActiveDownload | null {
	return active;
}

/** Whether `key` is the one downloading. */
export function isDownloading(key: string): boolean {
	return active?.key === key;
}

/**
 * On opening a screen: pick up a download started elsewhere or before a
 * reload. Polls Rust until it ends, since nothing here awaits it.
 */
export async function syncDownloads(): Promise<void> {
	// Progress events are a nicety; a webview that cannot listen still shows
	// which download is running.
	await ensureListening().catch(() => {});
	if (awaited) return;
	const key = await runningKey();
	if (!key) {
		active = null;
		return;
	}
	if (active?.key !== key) active = { key, progress: null };
	poll ??= setInterval(async () => {
		const still = await runningKey();
		if (!still && !awaited) {
			active = null;
			if (poll) clearInterval(poll);
			poll = null;
		}
	}, 2000);
}

/** Run one download through the store, so any screen can show it. */
export async function runDownload<T>(key: string, start: () => Promise<T>): Promise<T> {
	// Shown at once, before the listener is even up: the click answers itself.
	active = { key, progress: { downloaded: 0, total: 0, speed_bps: 0, stage: 'Starting…' } };
	awaited = true;
	try {
		await ensureListening();
		return await start();
	} finally {
		awaited = false;
		if (active?.key === key) active = null;
	}
}

/** Cancel whatever is downloading. Its promise rejects with "cancelled". */
export async function cancelDownload(): Promise<void> {
	await invoke('cancel_download').catch(() => {});
}

/** Test seam: forget everything. */
export function _resetDownloads(): void {
	active = null;
	awaited = false;
	listening = null;
	if (poll) clearInterval(poll);
	poll = null;
}
