/**
 * Save as for a picture in Chat: from the image viewer, and from the button on
 * each picture in an answer or on a step. The desktop reads the bytes (to name
 * the file by its real type), asks where in the native save dialog, and copies
 * the cached file there (`image_save_as`). The web client downloads it.
 */
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { imageSrc } from '#lib/images/url.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';
import { dataUrlBytes } from '#lib/utils/base64.ts';

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

/**
 * Save as for a picture a step holds only as a `data:` URL (a screenshot, a
 * file it read, a plot). The desktop stores it in the image cache unlinked,
 * where the next orphan sweep removes it, so the copy goes through
 * `image_save_as` like any other.
 */
export async function saveDataUrlImageAs(dataUrl: string, alt: string): Promise<ImageSaveResult> {
	const bytes = dataUrlBytes(dataUrl);
	if (!bytes) throw new Error('The picture has no data to save.');
	if (import.meta.env.VITE_HARUSPEX_WEB === '1') {
		const a = document.createElement('a');
		a.href = dataUrl;
		a.download = imageFileName(alt, imageExtension(bytes));
		a.click();
		return { kind: 'saved', path: a.download };
	}
	const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
	const { width, height } = bitmap;
	bitmap.close();
	const hash = await invoke<string>('image_store_bytes', {
		bytes: Array.from(bytes),
		mime: `image/${imageExtension(bytes).replace('jpg', 'jpeg')}`,
		width,
		height,
		conversationId: null
	});
	return saveImageAs(hash, alt);
}

/** Run a Save as and say how it went in a toast; a cancelled dialog says nothing. */
export async function saveWithToast(run: () => Promise<ImageSaveResult>): Promise<void> {
	try {
		const result = await run();
		if (result.kind === 'saved') showToast(`Saved to ${result.path}`);
	} catch (e) {
		showToast(`Could not save: ${errMessage(e)}`, { kind: 'error' });
	}
}
