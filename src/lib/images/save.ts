/**
 * Save as for a cached picture, from the image viewer. The desktop reads the
 * bytes (to name the file by its real type), asks where in the native save
 * dialog, and copies the cached file there (`image_save_as`). The web client
 * downloads it.
 */
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { imageSrc } from '#lib/images/url.ts';

/** A picture's file extension from its first bytes. */
export function imageExtension(b: Uint8Array): string {
	if (b[0] === 0x89 && b[1] === 0x50) return 'png';
	if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
	if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
	const ascii = String.fromCharCode(...b.subarray(0, 12));
	if (ascii.startsWith('RIFF') && ascii.slice(8) === 'WEBP') return 'webp';
	return 'png';
}

/** A file name from a picture's description. */
export function imageFileName(alt: string, ext: string): string {
	const base =
		alt
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'picture';
	return `${base}.${ext}`;
}

export type ImageSaveResult = { kind: 'saved'; path: string } | { kind: 'cancelled' };

export async function saveImageAs(hash: string, alt: string): Promise<ImageSaveResult> {
	if (import.meta.env.VITE_HARUSPEX_WEB === '1') {
		const r = await fetch(imageSrc(hash) ?? '', { credentials: 'same-origin' });
		if (!r.ok) throw new Error(`Image not found (${r.status})`);
		const bytes = new Uint8Array(await r.arrayBuffer());
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([bytes]));
		a.download = imageFileName(alt, imageExtension(bytes));
		a.click();
		return { kind: 'saved', path: a.download };
	}
	const bytes = new Uint8Array(await invoke<ArrayBuffer>('image_read_bytes', { hash }));
	const ext = imageExtension(bytes);
	const path = await save({
		title: 'Save picture',
		defaultPath: imageFileName(alt, ext),
		filters: [{ name: 'Image', extensions: [ext] }]
	});
	if (!path) return { kind: 'cancelled' };
	await invoke('image_save_as', { hash, path });
	return { kind: 'saved', path };
}
