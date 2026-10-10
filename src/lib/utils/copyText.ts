/**
 * Put text on the clipboard. `navigator.clipboard` only exists on secure
 * pages (HTTPS, localhost, the app's own webview); the web client served
 * over plain HTTP on a LAN has none, so it falls back to selecting a hidden
 * textarea and `document.execCommand('copy')`, which browsers still honour
 * inside a click. Throws when neither works.
 */
export async function copyText(text: string): Promise<void> {
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {
			// Denied (no focus, no permission): the fallback may still work.
		}
	}
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.opacity = '0';
	document.body.appendChild(area);
	area.select();
	try {
		if (!document.execCommand('copy')) throw new Error('the browser refused to copy');
	} finally {
		area.remove();
	}
}
