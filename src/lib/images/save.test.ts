import { describe, it, expect } from 'vitest';
import { imageExtension, imageFileName } from './save';
import { imageHashFromUrl } from './url';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('imageExtension', () => {
	it('reads a picture’s type from its first bytes', () => {
		expect(imageExtension(bytes(0x89, 0x50, 0x4e, 0x47))).toBe('png');
		expect(imageExtension(bytes(0xff, 0xd8, 0xff))).toBe('jpg');
		expect(imageExtension(ascii('GIF89a'))).toBe('gif');
		expect(imageExtension(ascii('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
	});
});

describe('imageFileName', () => {
	it('makes a file name from a description', () => {
		expect(imageFileName('A lighthouse at dusk', 'png')).toBe('a-lighthouse-at-dusk.png');
		expect(imageFileName('!!!', 'jpg')).toBe('picture.jpg');
	});
});

describe('imageHashFromUrl', () => {
	const h = 'c'.repeat(64);
	it('reads our image URLs in every form, and nothing else', () => {
		expect(imageHashFromUrl(`haruspex-img://localhost/${h}`)).toBe(h);
		expect(imageHashFromUrl(`http://haruspex-img.localhost/${h}`)).toBe(h);
		expect(imageHashFromUrl(`/api/v1/image/${h}`)).toBe(h);
		expect(imageHashFromUrl(`haruspex-audio://localhost/${h}`)).toBeNull();
		expect(imageHashFromUrl(`https://example.com/${h}`)).toBeNull();
		expect(imageHashFromUrl('haruspex-img://localhost/../x')).toBeNull();
	});
});
