/**
 * Runs in the app window, through `browser.execute`: make the saved keys
 * exactly `items`, then start the app over at `/`.
 *
 * Saved keys live in a file every build shares (`src/lib/persist.ts`), which
 * the app copies over `localStorage` as it loads — so writing `localStorage`
 * alone would be undone by the reload. Shared by the specs and the driver.
 */
export async function replaceSavedItems(items) {
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
