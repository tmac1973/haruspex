import { describe, it, expect } from 'vitest';
import {
	attachedAudioLine,
	splitAttachedAudio,
	withAttachedAudio,
	AUDIO_DROP_RE
} from './attached';
import { audioHashesInText } from '#lib/audio/eligible.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('attached audio', () => {
	it('writes one line per file after the text', () => {
		const text = withAttachedAudio('extract the vocals', [
			{ name: 'song.mp3', hash: A },
			{ name: 'take [2].wav', hash: B }
		]);
		expect(text).toBe(
			'extract the vocals\n\n' +
				`Attached audio: ![song.mp3](haruspex-audio://localhost/${A})\n` +
				`Attached audio: ![take  2 .wav](haruspex-audio://localhost/${B})`
		);
		expect(withAttachedAudio('hi', [])).toBe('hi');
		expect(withAttachedAudio('  ', [{ name: 'a.ogg', hash: A }])).toBe(
			attachedAudioLine({ name: 'a.ogg', hash: A })
		);
	});

	it('reads the lines back out, and leaves other text alone', () => {
		const text = withAttachedAudio('extract the vocals', [{ name: 'song.mp3', hash: A }]);
		expect(splitAttachedAudio(text)).toEqual({
			text: 'extract the vocals',
			audio: [{ name: 'song.mp3', hash: A }]
		});
		const typed = `Attached audio: ![x](https://example.com/${A})`;
		expect(splitAttachedAudio(typed)).toEqual({ text: typed, audio: [] });
	});

	it('is found by the rehydrate, so the sweep keeps the file', () => {
		expect(audioHashesInText([withAttachedAudio('', [{ name: 's.mp3', hash: A }])])).toEqual([A]);
	});

	it('takes the formats music tools read and the ones ffmpeg converts', () => {
		for (const name of ['a.mp3', 'b.WAV', 'c.flac', 'd.ogg', 'e.wma', 'f.M4A', 'g.aac', 'h.opus'])
			expect(AUDIO_DROP_RE.test(name)).toBe(true);
		for (const name of ['a.mp4', 'b.png', 'mp3']) expect(AUDIO_DROP_RE.test(name)).toBe(false);
	});
});
