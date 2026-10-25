import { describe, it, expect } from 'vitest';
import { webAudioSrc } from './audio';

const HASH = 'ab'.repeat(32);

describe('webAudioSrc', () => {
	it('maps both desktop forms to the server route', () => {
		expect(webAudioSrc(`haruspex-audio://localhost/${HASH}`)).toBe(`/api/v1/audio/${HASH}`);
		expect(webAudioSrc(`http://haruspex-audio.localhost/${HASH}`)).toBe(`/api/v1/audio/${HASH}`);
	});

	it('leaves anything else alone', () => {
		expect(webAudioSrc('https://example.com/song.mp3')).toBeNull();
		expect(webAudioSrc(`haruspex-img://localhost/${HASH}`)).toBeNull();
	});
});
