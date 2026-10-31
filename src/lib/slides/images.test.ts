import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { imageDimensions, loadSlideImages, MAX_SLIDE_IMAGE_BYTES, slideImageMime } from './images';
import { gifHeader, jpegHeader, pngHeader } from './testImages';

describe('slideImageMime', () => {
	it.each([
		['a.png', 'image/png'],
		['dir/B.JPG', 'image/jpeg'],
		['c.jpeg', 'image/jpeg'],
		['d.gif', 'image/gif'],
		['e.webp', null],
		['noext', null]
	])('%s → %s', (path, mime) => {
		expect(slideImageMime(path)).toBe(mime);
	});
});

describe('imageDimensions', () => {
	it('reads a PNG, a GIF and a JPEG', () => {
		expect(imageDimensions(pngHeader(1920, 1080), 'image/png')).toEqual({
			width: 1920,
			height: 1080
		});
		expect(imageDimensions(gifHeader(320, 240), 'image/gif')).toEqual({ width: 320, height: 240 });
		expect(imageDimensions(jpegHeader(800, 600), 'image/jpeg')).toEqual({
			width: 800,
			height: 600
		});
	});

	it('reads a view into a larger buffer', () => {
		const outer = new Uint8Array(100);
		outer.set(pngHeader(10, 20), 7);
		expect(imageDimensions(outer.subarray(7, 40), 'image/png')).toEqual({ width: 10, height: 20 });
	});

	it('is null for bytes that are not the picture the name says', () => {
		expect(
			imageDimensions(new TextEncoder().encode('not a picture at all'), 'image/png')
		).toBeNull();
		expect(imageDimensions(pngHeader(10, 10), 'image/jpeg')).toBeNull();
		expect(imageDimensions(jpegHeader(10, 10), 'image/gif')).toBeNull();
		expect(imageDimensions(pngHeader(0, 10), 'image/png')).toBeNull();
	});
});

describe('loadSlideImages', () => {
	beforeEach(() => mocks.invoke.mockReset());

	it('reads each picture once, however many slides use it', async () => {
		mocks.invoke.mockResolvedValue(Array.from(pngHeader(4, 3)));
		const images = await loadSlideImages('/w', [
			{ title: 'A', image: 'a.png' },
			{ title: 'B' },
			{ title: 'C', image: 'a.png' }
		]);
		expect(mocks.invoke).toHaveBeenCalledTimes(1);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_read_bytes', { workdir: '/w', relPath: 'a.png' });
		expect(images.get('a.png')).toMatchObject({ mime: 'image/png', width: 4, height: 3 });
	});

	it('refuses a format no deck shows, before reading it', async () => {
		await expect(loadSlideImages('/w', [{ title: 'A', image: 'a.webp' }])).rejects.toThrow(
			"Unsupported image extension 'webp' for a.webp — only png, jpg, jpeg, gif are embeddable"
		);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('refuses a picture past the size limit', async () => {
		const big = new Array(MAX_SLIDE_IMAGE_BYTES + 1).fill(0);
		mocks.invoke.mockResolvedValue(big);
		await expect(loadSlideImages('/w', [{ title: 'A', image: 'a.png' }])).rejects.toThrow(
			/^Image a.png is too large/
		);
	});

	it('refuses a file that is not the picture its name says', async () => {
		mocks.invoke.mockResolvedValue(Array.from(new TextEncoder().encode('hello')));
		await expect(loadSlideImages('/w', [{ title: 'A', image: 'a.jpg' }])).rejects.toThrow(
			'Image a.jpg is not a readable JPEG.'
		);
	});
});
