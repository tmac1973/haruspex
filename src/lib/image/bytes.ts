/**
 * A picture's bytes: read from the image cache, named by type, sent as a data
 * URL, and checked for transparency. Shared by the backends that send
 * pictures as data URLs and by the callers that read the cache directly.
 */
import { invoke } from '@tauri-apps/api/core';
import { bytesToBase64 } from '#lib/utils/base64.ts';

/** The type a picture's first bytes say it is; PNG when they say nothing. */
export function mimeOf(bytes: Uint8Array): string {
	const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
	if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
	if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
	return 'image/png';
}

/** A cached picture's bytes, by its hash. Rejects when it is not in the cache. */
export async function readCachedImage(hash: string): Promise<Uint8Array> {
	return new Uint8Array(await invoke<ArrayBuffer>('image_read_bytes', { hash }));
}

/** `bytes` as a `data:` URL of the type they say they are. */
export function imageDataUrl(bytes: Uint8Array): string {
	return `data:${mimeOf(bytes)};base64,${bytesToBase64(bytes)}`;
}

/**
 * Whether `png` has no pixel short of opaque: a transparent request that came
 * back solid. False when it has one, and when the check itself fails, since a
 * failed check proves nothing.
 */
export async function isFullyOpaque(png: Uint8Array): Promise<boolean> {
	try {
		const clear = await invoke<number>('image_transparent_fraction', { bytes: Array.from(png) });
		return clear <= 0;
	} catch {
		return false;
	}
}
