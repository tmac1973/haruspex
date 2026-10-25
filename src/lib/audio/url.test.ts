import { describe, it, expect } from 'vitest';
import { audioHashFromUrl, audioSrc } from './url';

const HASH = '0123456789abcdef'.repeat(4);

describe('audioSrc', () => {
	it('uses one of the two platform shapes, hash in the path', () => {
		const src = audioSrc(HASH);
		expect([
			`http://haruspex-audio.localhost/${HASH}`,
			`haruspex-audio://localhost/${HASH}`
		]).toContain(src);
	});

	it.each([
		['uppercase', 'A'.repeat(64)],
		['too short', 'a'.repeat(63)],
		['traversal', '../../etc/passwd'],
		['empty', '']
	])('refuses a %s hash', (_label, bad) => {
		expect(audioSrc(bad)).toBeNull();
	});
});

describe('audioHashFromUrl', () => {
	it('reads either platform form', () => {
		expect(audioHashFromUrl(`haruspex-audio://localhost/${HASH}`)).toBe(HASH);
		expect(audioHashFromUrl(`http://haruspex-audio.localhost/${HASH}`)).toBe(HASH);
	});

	it('ignores image URLs, other hosts and bad hashes', () => {
		expect(audioHashFromUrl(`haruspex-img://localhost/${HASH}`)).toBeNull();
		expect(audioHashFromUrl(`https://example.com/${HASH}`)).toBeNull();
		expect(audioHashFromUrl('haruspex-audio://localhost/../secret')).toBeNull();
	});
});
