import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapshotProblems } from './snapshot';

const W = 64;
const H = 48;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** Stub the decoder and canvas so `getImageData` returns `pixels`. */
function stubPixels(pixels: Uint8ClampedArray) {
	const close = vi.fn();
	vi.stubGlobal(
		'createImageBitmap',
		vi.fn(async () => ({ close }))
	);
	vi.stubGlobal(
		'OffscreenCanvas',
		class {
			getContext() {
				return { drawImage: vi.fn(), getImageData: () => ({ data: pixels }) };
			}
		}
	);
	return close;
}

function flat(r: number, g: number, b: number): Uint8ClampedArray {
	const px = new Uint8ClampedArray(W * H * 4);
	for (let i = 0; i < px.length; i += 4) px.set([r, g, b, 255], i);
	return px;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('snapshotProblems', () => {
	it('flags one flat colour', async () => {
		const close = stubPixels(flat(8, 9, 20));
		expect(await snapshotProblems(PNG)).toEqual(['The scene rendered nothing visible.']);
		expect(close).toHaveBeenCalled();
	});

	it('passes a picture with a block of another colour', async () => {
		const px = flat(8, 9, 20);
		for (let y = 20; y < 28; y++) {
			for (let x = 30; x < 38; x++) px.set([200, 120, 40, 255], (y * W + x) * 4);
		}
		stubPixels(px);
		expect(await snapshotProblems(PNG)).toEqual([]);
	});

	it('counts pixels within 4 on each channel as flat', async () => {
		const px = flat(100, 100, 100);
		for (let i = 4; i < px.length; i += 8) px.set([104, 96, 103], i);
		stubPixels(px);
		expect(await snapshotProblems(PNG)).toEqual(['The scene rendered nothing visible.']);
		px.set([105, 100, 100], 4 * 6);
		expect(await snapshotProblems(PNG)).toEqual([]);
	});
});
