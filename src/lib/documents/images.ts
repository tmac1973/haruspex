import type { SlideImage } from '#lib/slides/types.ts';
import { base64ToBytes, bytesToBase64 } from '#lib/utils/base64.ts';

/**
 * A GIF as a PNG, drawn through a canvas: pdfmake places only PNG and JPEG.
 * An animated GIF keeps its first frame.
 */
export function gifToPng(image: SlideImage): Promise<SlideImage> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		const fail = () => reject(new Error('A GIF in the document could not be converted to PNG.'));
		img.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			const ctx = canvas.getContext('2d');
			if (!ctx) return fail();
			ctx.drawImage(img, 0, 0);
			const url = canvas.toDataURL('image/png');
			const bytes = base64ToBytes(url.slice(url.indexOf(',') + 1));
			resolve({ mime: 'image/png', bytes, width: canvas.width, height: canvas.height });
		};
		img.onerror = fail;
		img.src = `data:image/gif;base64,${bytesToBase64(image.bytes)}`;
	});
}
