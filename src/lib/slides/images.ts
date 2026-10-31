import { invoke } from '@tauri-apps/api/core';
import type { Slide, SlideImage } from '#lib/slides/types.ts';

/** The largest picture a deck embeds, as for the document writers. */
export const MAX_SLIDE_IMAGE_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, SlideImage['mime']> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif'
};

/**
 * The formats PowerPoint and LibreOffice both show. Narrower than what
 * `fs_read_image` previews, like the Rust document writers' list.
 */
export function slideImageMime(path: string): SlideImage['mime'] | null {
	const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
	return MIME_BY_EXT[ext] ?? null;
}

/** A picture's size in pixels, read from its header; null when it isn't one. */
export function imageDimensions(
	bytes: Uint8Array,
	mime: SlideImage['mime']
): { width: number; height: number } | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (mime === 'image/png') {
		// The signature, then IHDR: its width and height come first.
		if (bytes.length < 24 || view.getUint32(0) !== 0x89504e47) return null;
		return positive(view.getUint32(16), view.getUint32(20));
	}
	if (mime === 'image/gif') {
		if (bytes.length < 10 || view.getUint32(0) !== 0x47494638) return null;
		return positive(view.getUint16(6, true), view.getUint16(8, true));
	}
	return jpegDimensions(bytes, view);
}

/** Walk a JPEG's segments to the first start-of-frame, which holds its size. */
function jpegDimensions(
	bytes: Uint8Array,
	view: DataView
): { width: number; height: number } | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let i = 2;
	while (i + 9 < bytes.length) {
		if (bytes[i] !== 0xff) return null;
		const marker = bytes[i + 1];
		if (marker === 0xff) {
			i += 1; // fill byte
			continue;
		}
		// SOF0–SOF15, less DHT (C4), JPG (C8) and DAC (CC), which share the range.
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
			return positive(view.getUint16(i + 7), view.getUint16(i + 5));
		}
		// Markers with no length: TEM and the restart markers.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2;
			continue;
		}
		i += 2 + view.getUint16(i + 2);
	}
	return null;
}

function positive(width: number, height: number): { width: number; height: number } | null {
	return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Read and measure every picture the slides name, once each. Throws a message
 * the model can act on: a format no deck shows, a file too large, or one that
 * isn't the picture its name says.
 */
export async function loadSlideImages(
	workdir: string,
	slides: Slide[]
): Promise<Map<string, SlideImage>> {
	const images = new Map<string, SlideImage>();
	for (const path of new Set(slides.flatMap((s) => (s.image ? [s.image] : [])))) {
		const mime = slideImageMime(path);
		if (!mime) {
			const ext = /\.([^./\\]+)$/.exec(path)?.[1] ?? '';
			throw new Error(
				`Unsupported image extension '${ext}' for ${path} — only png, jpg, jpeg, gif are embeddable`
			);
		}
		const bytes = Uint8Array.from(
			await invoke<number[]>('fs_read_bytes', { workdir, relPath: path })
		);
		if (bytes.length > MAX_SLIDE_IMAGE_BYTES) {
			throw new Error(
				`Image ${path} is too large (${bytes.length} bytes). Max is ${MAX_SLIDE_IMAGE_BYTES} bytes.`
			);
		}
		const size = imageDimensions(bytes, mime);
		if (!size) throw new Error(`Image ${path} is not a readable ${mime.slice(6).toUpperCase()}.`);
		images.set(path, { mime, bytes, ...size });
	}
	return images;
}
