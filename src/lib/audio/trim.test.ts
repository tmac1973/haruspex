import { describe, it, expect } from 'vitest';
import { cutChannels, encodeWav, trimToWav, wavBytesFor, TRIM_SAMPLE_RATE } from './trim';

const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i / n);

describe('trim', () => {
	it('keeps the samples between the two times, faded at the cuts', () => {
		const [cut] = cutChannels([new Float32Array(1000).fill(0.5)], 100, 2, 5);
		expect(cut.length).toBe(300);
		expect(cut[0]).toBe(0);
		expect(cut[150]).toBe(0.5);
		expect(cut[299]).toBe(0);
		expect(cutChannels([ramp(100)], 100, 0.5, 9)[0].length).toBe(50);
	});

	it('writes a 16-bit PCM WAV header and interleaves the channels', () => {
		const wav = encodeWav([Float32Array.of(1, -1), Float32Array.of(0, 0.5)], 48000);
		const view = new DataView(wav.buffer);
		const text = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
		expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
		expect(view.getUint16(22, true)).toBe(2);
		expect(view.getUint32(24, true)).toBe(48000);
		expect(view.getUint32(40, true)).toBe(8);
		expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
			32767, 0, -32768, 16383
		]);
	});

	it('trims a decoded song to a WAV of the stretch', async () => {
		const decode = async () => [
			new Float32Array(TRIM_SAMPLE_RATE * 10),
			new Float32Array(TRIM_SAMPLE_RATE * 10)
		];
		const wav = await trimToWav(new ArrayBuffer(4), 2, 6, decode);
		expect(wav.length).toBe(wavBytesFor(4));
		await expect(trimToWav(new ArrayBuffer(4), 0, 1, async () => [])).rejects.toThrow(/no audio/);
	});
});
