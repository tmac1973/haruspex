/**
 * The key the bundled llama-server demands as `Authorization: Bearer`.
 *
 * Rust makes a fresh one each run and hands it to llama-server through its
 * environment, so a web page open in the user's browser can't drive the
 * loopback port. Chat requests are the webview's own `fetch`, so the webview
 * needs the key too: it is read once per run, and every request path waits
 * for that (`localServerKeyReady`) before resolving its descriptor.
 */
import { invoke } from '@tauri-apps/api/core';

let key: string | undefined;
let ready: Promise<void> | null = null;

/** Read the key into memory, once per run. A failed read is retried next call. */
export function localServerKeyReady(): Promise<void> {
	ready ??= invoke<string>('get_llama_api_key').then(
		(k) => {
			key = k;
		},
		(e) => {
			ready = null;
			console.warn('Could not read the llama-server key:', e);
		}
	);
	return ready;
}

/** The key, once `localServerKeyReady` has resolved. */
export function localServerKey(): string | undefined {
	return key;
}
