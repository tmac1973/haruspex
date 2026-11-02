/**
 * Seeding the app's saved keys (the settings blob, the active tab, …).
 *
 * Saved keys live in a file every build shares (`src/lib/persist.ts`), which
 * the app copies over `localStorage` as it loads — so writing `localStorage`
 * alone would be undone by the reload. Shared by the specs and the driver.
 */

/**
 * Runs in the app window, through `browser.execute`: make the saved keys
 * exactly `items`, then start the app over at `/`.
 */
export async function replaceSavedItems(items) {
	// So this page, until it is replaced, can't pass for the restarted one.
	delete window.__haruspexSavedLoaded;
	const { invoke } = window.__TAURI_INTERNALS__;
	const stored = (await invoke('webview_store_load')) ?? {};
	for (const key of Object.keys(stored)) {
		if (!(key in items)) await invoke('webview_store_set', { key, value: null });
	}
	for (const [key, value] of Object.entries(items)) {
		await invoke('webview_store_set', { key, value });
	}
	localStorage.clear();
	for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
	location.replace('/');
}

/**
 * Seed `items` and wait for the restarted app to have loaded them.
 *
 * The page being replaced keeps saving while the seed's writes are in flight
 * (a fresh install's first page is still starting up), and one of its writes
 * can land after them; then the restarted app loads that instead. So check
 * what it started from, and seed again when that isn't `items`.
 */
export async function seedSavedItems(browser, items, { attempts = 5 } = {}) {
	for (let attempt = 1; ; attempt++) {
		// WebView2 can report the page complete before Tauri has injected its
		// IPC bridge, and replaceSavedItems needs it.
		await browser.waitUntil(
			async () =>
				await browser.execute(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function'),
			{
				timeout: 30_000,
				timeoutMsg: 'the app window never had window.__TAURI_INTERNALS__, so it cannot be seeded'
			}
		);
		await browser.execute(replaceSavedItems, items);
		await browser.pause(500);
		// What the app started from, before it changed anything itself. Read in
		// the same call that sees it, since the page can still be swapping.
		let loaded;
		await browser.waitUntil(
			async () => {
				loaded = await browser.execute(() =>
					document.readyState === 'complete' ? (window.__haruspexSavedLoaded ?? null) : null
				);
				return !!loaded;
			},
			{ timeout: 30_000, timeoutMsg: 'the app did not come back after seeding' }
		);
		if (Object.entries(items).every(([k, v]) => loaded[k] === v)) return;
		if (attempt === attempts) {
			throw new Error(`the app kept loading other settings than the seeded ones`);
		}
	}
}
