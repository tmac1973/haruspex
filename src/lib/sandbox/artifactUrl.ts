/**
 * The URL an artifact document is served at. Tauri exposes custom schemes as
 * `http://<scheme>.localhost` on Windows and Android, and as the native
 * `<scheme>://localhost` on Linux (WebKitGTK) and macOS — the same split the
 * sandbox's `haruspexfetch:` bridge makes.
 */
export function artifactUrl(id: string, userAgent = globalThis.navigator?.userAgent ?? ''): string {
	const base = /Windows|Android/i.test(userAgent)
		? 'http://haruspex-artifact.localhost/'
		: 'haruspex-artifact://localhost/';
	return `${base}${encodeURIComponent(id)}`;
}
