import { describe, it, expect } from 'vitest';
import { imageSrc } from './url';

const HASH = '0123456789abcdef'.repeat(4);

describe('imageSrc', () => {
	it('addresses a cached image by hash', () => {
		const src = imageSrc(HASH);
		expect(src).not.toBeNull();
		expect(src).toContain(HASH);
	});

	it('puts the hash in the path, never the host', () => {
		// A DNS label caps at 63 characters and the hash is 64, so a
		// hash-as-host URL would be malformed before it reached Rust.
		const src = imageSrc(HASH)!;
		expect(src.endsWith(`/${HASH}`)).toBe(true);
		expect(src).toMatch(/haruspex-img(\.localhost|:\/\/localhost)/);
	});

	it('uses one of the two platform shapes and nothing else', () => {
		const src = imageSrc(HASH)!;
		const windowsShape = `http://haruspex-img.localhost/${HASH}`;
		const unixShape = `haruspex-img://localhost/${HASH}`;
		expect([windowsShape, unixShape]).toContain(src);
	});

	it.each([
		['uppercase', 'A'.repeat(64)],
		['too short', 'a'.repeat(63)],
		['too long', 'a'.repeat(65)],
		['non-hex', 'g'.repeat(64)],
		['traversal', '../../etc/passwd'],
		['empty', '']
	])('refuses a %s hash rather than emitting a bad URL', (_label, bad) => {
		expect(imageSrc(bad)).toBeNull();
	});
});
