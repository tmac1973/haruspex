/** Base64 of raw bytes (no data: prefix). Built 32 KB at a time, so a large
 *  image can't overflow the argument limit `String.fromCharCode(...bytes)` hits. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** A PNG as a data URL — bytes a vision model can be handed without a file on disk. */
export function pngDataUrl(bytes: Uint8Array): string {
	return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

/** The bytes of plain base64 (no data: prefix). Throws on malformed input, as `atob` does. */
export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** The bytes of a base64 `data:` URL, or null for anything else. */
export function dataUrlBytes(url: string): Uint8Array | null {
	const m = url.match(/^data:[^;,]*;base64,(.*)$/s);
	if (!m) return null;
	try {
		return base64ToBytes(m[1]);
	} catch {
		return null;
	}
}
