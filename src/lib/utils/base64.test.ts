import { describe, expect, it } from 'vitest';
import { bytesToBase64, pngDataUrl } from './base64';

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

describe('pngDataUrl', () => {
	it('prefixes the PNG media type', () => {
		expect(pngDataUrl(new Uint8Array([1]))).toBe('data:image/png;base64,AQ==');
	});
});
