/**
 * Picture headers for the slide tests: enough bytes for `imageDimensions` to
 * read a size, which is all the deck builder looks at. Not shipped.
 */

export function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	const view = new DataView(bytes.buffer);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	view.setUint32(8, 13);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

export function gifHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(13);
	const view = new DataView(bytes.buffer);
	bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
	view.setUint16(6, width, true);
	view.setUint16(8, height, true);
	return bytes;
}

/** SOI, an APP0 segment to step over, then a baseline start-of-frame. */
export function jpegHeader(width: number, height: number): Uint8Array {
	const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
	const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff];
	return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(12).fill(0)]);
}
