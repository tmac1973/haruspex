import { describe, expect, it } from 'vitest';
import { pngSize } from './png';

/** A PNG header claiming w×h — all `pngSize` reads. */
function png(w: number, h: number): Uint8Array {
	const b = new Uint8Array(24);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const v = new DataView(b.buffer);
	v.setUint32(16, w);
	v.setUint32(20, h);
	return b;
}

describe('pngSize', () => {
	it('reads the width and height from the header', () => {
		expect(pngSize(png(48, 16))).toEqual({ width: 48, height: 16 });
	});

	it('reads a header that starts partway into its buffer', () => {
		const buf = new Uint8Array(30);
		buf.set(png(7, 9), 6);
		expect(pngSize(buf.subarray(6))).toEqual({ width: 7, height: 9 });
	});

	it('refuses bytes that are not a PNG', () => {
		expect(pngSize(new Uint8Array(30))).toBeNull();
		expect(pngSize(png(1, 1).subarray(0, 23))).toBeNull();
	});

	it('checks every byte of the signature', () => {
		for (let i = 0; i < 8; i++) {
			const b = png(4, 4);
			b[i] ^= 0xff;
			expect(pngSize(b)).toBeNull();
		}
	});
});
