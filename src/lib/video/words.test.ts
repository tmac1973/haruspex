import { describe, it, expect } from 'vitest';
import { parseWordStretch, wordTime, wordsReport } from './words';
import type { Transcript } from '#lib/ipc/gen/Transcript.ts';

const t = (words: { start: number; end: number; text: string }[]): Transcript => ({
	path: 'vo.wav',
	model: 'ggml-large-v3-turbo.bin',
	language: 'en',
	durationSecs: 60,
	segments: [{ start: 0, end: 60, text: words.map((w) => w.text).join(' '), words }]
});

describe('word times', () => {
	it('writes hundredths', () => {
		expect(wordTime(0)).toBe('0:00.00');
		expect(wordTime(65.237)).toBe('1:05.24');
		expect(wordTime(3725.5)).toBe('62:05.50');
	});

	it('reads a stretch, defaulting to the whole clip', () => {
		expect(parseWordStretch(undefined)).toBeNull();
		expect(parseWordStretch({})).toEqual({ from: 0, to: Infinity });
		expect(parseWordStretch({ from: '0:40', to: 50 })).toEqual({ from: 40, to: 50 });
		expect(parseWordStretch({ from: '0:40', to: '0:10' })).toContain('after "from"');
		expect(parseWordStretch('0:40')).toContain('"words" is');
	});

	it('stops at the cap and says where to go on', () => {
		const words = Array.from({ length: 10 }, (_, i) => ({ start: i, end: i + 0.5, text: `w${i}` }));
		const text = wordsReport([t(words)], { from: 0, to: Infinity }, 3);
		expect(text.split('\n')).toHaveLength(5);
		expect(text).toContain('0:02.00–0:02.50 w2');
		expect(text).toContain('ask again with words.from "0:03.00"');
	});

	it('says when whisper gave no word times', () => {
		expect(wordsReport([t([])], { from: 0, to: 10 })).toContain('no word times');
	});
});
