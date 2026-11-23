import { describe, expect, it } from 'vitest';
import { mediaUrls } from './mediaUrl';

const HASH = 'a'.repeat(64);

describe('mediaUrls', () => {
	const audio = mediaUrls('haruspex-audio', '/api/v1/audio/');
	const image = mediaUrls('haruspex-img', '/api/v1/image/', { acceptWebRoute: true });

	it('reads the hash from either platform form', () => {
		expect(audio.hashFromUrl(`haruspex-audio://localhost/${HASH}`)).toBe(HASH);
		expect(audio.hashFromUrl(` http://haruspex-audio.localhost/${HASH} `)).toBe(HASH);
		expect(audio.pattern.test(`http://haruspex-audio.localhost/${HASH}`)).toBe(true);
	});

	it('takes the web route only when asked to', () => {
		expect(image.hashFromUrl(`/api/v1/image/${HASH}`)).toBe(HASH);
		expect(audio.hashFromUrl(`/api/v1/audio/${HASH}`)).toBeNull();
	});

	it("refuses another scheme's URL and a hash of the wrong shape", () => {
		expect(audio.hashFromUrl(`haruspex-video://localhost/${HASH}`)).toBeNull();
		expect(audio.hashFromUrl(`haruspex-audio://localhost/${HASH.toUpperCase()}`)).toBeNull();
		expect(audio.src('abc')).toBeNull();
		expect(audio.src(HASH)).toMatch(new RegExp(`${HASH}$`));
	});
});
