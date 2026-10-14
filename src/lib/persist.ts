/**
 * The webview's saved keys, shared by every build of the app.
 *
 * `localStorage` is per origin, and a dev build (`http://localhost:1420`) and
 * a packaged one (`tauri://localhost`, `http://tauri.localhost` on Windows)
 * are different origins — so each used to keep its own settings. The real
 * store is now a file in the app data directory (`webview_store.rs`).
 *
 * This module copies that file into `localStorage` with a top-level await,
 * so every module that imports it — directly or not — evaluates after the
 * copy and can keep reading `localStorage` synchronously. Writes go through
 * {@link persistItem}, which updates both. On the first launch after this
 * shipped there is no file yet, and the window starts it from its own
 * `localStorage`.
 *
 * Outside Tauri (unit tests, the e2e browser before its mocks) it does
 * nothing beyond `localStorage`.
 */
import { invoke } from '@tauri-apps/api/core';

/** `isTauri()` from `@tauri-apps/api/core`, read directly: many unit tests
 *  mock that module without it. */
function isTauri(): boolean {
	return (globalThis as { isTauri?: boolean }).isTauri === true;
}

/** Every saved key starts with this; the Rust side refuses anything else. */
const PREFIX = 'haruspex';

/** Long enough for a cold disk, short enough that a wedged backend can't
 *  hold the window blank: past it the window runs on `localStorage`. */
const LOAD_TIMEOUT_MS = 5000;

type Items = Record<string, string>;

function localItems(): Items {
	const items: Items = {};
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		if (key?.startsWith(PREFIX)) items[key] = localStorage.getItem(key) ?? '';
	}
	return items;
}

/** Make this origin's `localStorage` hold exactly `items` for our keys. */
function apply(items: Items): void {
	for (const key of Object.keys(localItems())) {
		if (!(key in items)) localStorage.removeItem(key);
	}
	for (const [key, value] of Object.entries(items)) {
		if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
	}
}

async function hydrate(): Promise<void> {
	if (!isTauri()) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error('timed out')), LOAD_TIMEOUT_MS);
	});
	try {
		const load = async () => {
			const stored = await invoke<Items | null>('webview_store_load');
			return stored ?? (await invoke<Items>('webview_store_seed', { items: localItems() }));
		};
		apply(await Promise.race([load(), timeout]));
	} catch (e) {
		console.warn('Saved settings could not be read; using this build’s own copy:', e);
	} finally {
		clearTimeout(timer);
	}
}

await hydrate();
// What this page started from, before any store changed it: the real-app
// tests' seeding (e2e/app/storage.mjs) checks it got what was seeded.
(globalThis as { __haruspexSavedLoaded?: Items }).__haruspexSavedLoaded = localItems();

// Writes waiting for the file, newest value per key.
const pending = new Map<string, string>();
let flushing = false;
let warned = false;

async function flush(): Promise<void> {
	if (flushing) return;
	flushing = true;
	try {
		// One at a time, in order, so an older value can never land last.
		while (pending.size > 0) {
			const [key, value] = pending.entries().next().value as [string, string];
			pending.delete(key);
			try {
				await invoke('webview_store_set', { key, value });
			} catch (e) {
				if (!warned) console.warn('Saving settings to disk failed:', e);
				warned = true;
			}
		}
	} finally {
		flushing = false;
	}
}

function queue(key: string, value: string): void {
	if (!isTauri()) return;
	pending.set(key, value);
	void flush();
}

/** `localStorage.setItem`, kept for every build. Throws as `setItem` does. */
export function persistItem(key: string, value: string): void {
	queue(key, value);
	localStorage.setItem(key, value);
}
