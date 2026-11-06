/** The eight bytes every PNG starts with. */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's pixel size from its IHDR header, or null if it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 24 || SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: v.getUint32(16), height: v.getUint32(20) };
}
