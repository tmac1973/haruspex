/**
 * Base URL of a Tauri custom URI scheme. Tauri exposes them as
 * `http://<scheme>.localhost/` on Windows and Android, but as the native
 * `<scheme>://localhost/` on Linux (WebKitGTK) and macOS. Using the wrong form
 * sends the request to the real network ("Connection refused") instead of
 * the scheme handler. Works in workers too, where there is no `window`.
 */
export function customSchemeBase(
	scheme: string,
	userAgent: string = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
): string {
	return /Windows|Android/i.test(userAgent)
		? `http://${scheme}.localhost/`
		: `${scheme}://localhost/`;
}
