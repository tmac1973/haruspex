/** Image MIME types by file extension: every kind the image viewer shows. */
export const IMAGE_MIME = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	bmp: 'image/bmp',
	svg: 'image/svg+xml'
} as const;

export type ImageExt = keyof typeof IMAGE_MIME;

/** A path's extension, lowercased: what follows its last dot (the whole name when it has none). */
export function extOf(path: string): string {
	return path.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * The MIME type for the lowercased extension `ext`, or null when it isn't an
 * image or isn't among `only` (a caller that takes fewer kinds).
 */
export function imageMime<E extends ImageExt = ImageExt>(
	ext: string,
	only?: readonly E[]
): (typeof IMAGE_MIME)[E] | null {
	if (!Object.hasOwn(IMAGE_MIME, ext)) return null;
	if (only && !only.includes(ext as E)) return null;
	return IMAGE_MIME[ext as E];
}
