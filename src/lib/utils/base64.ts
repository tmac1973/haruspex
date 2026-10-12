/** Base64 of raw bytes (no data: prefix). Built a byte at a time, so a large
 *  image can't overflow the argument limit `String.fromCharCode(...bytes)` hits. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

/** A PNG as a data URL — bytes a vision model can be handed without a file on disk. */
export function pngDataUrl(bytes: Uint8Array): string {
	return `data:image/png;base64,${bytesToBase64(bytes)}`;
}
