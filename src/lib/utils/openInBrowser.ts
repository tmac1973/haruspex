import { invoke } from '@tauri-apps/api/core';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { urlForReport } from '#lib/utils/http.ts';

/**
 * Open a web address in the user's browser, through Rust's `open_url` (see
 * the layout's `openExternalLinks` for why not the webview). Never throws: a
 * failure is logged and shown as a toast, so a click handler can call it
 * with `void`.
 */
export async function openInBrowser(url: string): Promise<void> {
	try {
		await invoke('open_url', { url });
	} catch (err) {
		console.error('open_url failed:', urlForReport(url), err);
		showToast("Couldn't open link in your browser", { kind: 'error' });
	}
}
