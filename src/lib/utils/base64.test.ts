import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, dataUrlBytes, pngDataUrl } from './base64';

describe('bytesToBase64', () => {
	it('encodes bytes', () => {
		expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
	});

	it('encodes an empty buffer', () => {
		expect(bytesToBase64(new Uint8Array())).toBe('');
	});

	it('handles buffers larger than the spread-argument limit', () => {
		const big = new Uint8Array(300_000).fill(255);
		expect(atob(bytesToBase64(big)).length).toBe(300_000);
	});
});

describe('base64ToBytes', () => {
	it('decodes what bytesToBase64 encodes', () => {
		const bytes = new Uint8Array([0, 1, 127, 128, 255]);
		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
	});

	it('throws on malformed input', () => {
		expect(() => base64ToBytes('not base64!')).toThrow();
	});
});

describe('pngDataUrl', () => {
	it('prefixes the PNG media type', () => {
		expect(pngDataUrl(new Uint8Array([1]))).toBe('data:image/png;base64,AQ==');
	});
});

describe('dataUrlBytes', () => {
	it('decodes what pngDataUrl encodes', () => {
		expect(dataUrlBytes(pngDataUrl(new Uint8Array([1, 2, 255])))).toEqual(
			new Uint8Array([1, 2, 255])
		);
	});

	it('refuses anything that is not a base64 data URL', () => {
		expect(dataUrlBytes('https://example.com/a.png')).toBeNull();
		expect(dataUrlBytes('data:text/plain,hello')).toBeNull();
		expect(dataUrlBytes('data:image/png;base64,***')).toBeNull();
	});
});
