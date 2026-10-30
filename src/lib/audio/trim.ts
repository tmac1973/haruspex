/**
 * Cut a stretch out of a song, here in the webview: decode it with Web Audio,
 * keep the samples between two times, and write them as a 16-bit WAV. No
 * server and no ffmpeg, so it works with any music backend. `edit_music`'s
 * `trim` uses it, so a part of a song (one voice of an extracted vocal, say)
 * can be a `style_reference` or a `source` on its own.
 */

/** ACE-Step's own rate, so the server doesn't resample what it is sent. */
export const TRIM_SAMPLE_RATE = 48000;

/** A short fade at each cut, so the clip doesn't start or end on a click. */
const FADE_SECONDS = 0.01;

/** The channels of `bytes`, decoded at `TRIM_SAMPLE_RATE`. */
export type DecodeSong = (bytes: ArrayBuffer) => Promise<Float32Array[]>;

export const decodeSong: DecodeSong = async (bytes) => {
	const ctx = new OfflineAudioContext(1, 1, TRIM_SAMPLE_RATE);
	const buf = await ctx.decodeAudioData(bytes);
	const channels: Float32Array[] = [];
	for (let c = 0; c < Math.min(buf.numberOfChannels, 2); c++) channels.push(buf.getChannelData(c));
	return channels;
};

/** The samples from `start` to `end` seconds, faded in and out at the cuts. */
export function cutChannels(
	channels: Float32Array[],
	rate: number,
	start: number,
	end: number
): Float32Array[] {
	const from = Math.max(0, Math.round(start * rate));
	const fade = Math.round(FADE_SECONDS * rate);
	return channels.map((ch) => {
		const out = ch.slice(from, Math.min(ch.length, Math.round(end * rate)));
		const n = Math.min(fade, Math.floor(out.length / 2));
		for (let i = 0; i < n; i++) {
			out[i] *= i / n;
			out[out.length - 1 - i] *= i / n;
		}
		return out;
	});
}

/** A 16-bit PCM WAV of `channels` (all one length). */
export function encodeWav(channels: Float32Array[], rate: number): Uint8Array {
	const count = channels.length;
	const frames = channels[0]?.length ?? 0;
	const dataBytes = frames * count * 2;
	const out = new Uint8Array(44 + dataBytes);
	const view = new DataView(out.buffer);
	const ascii = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
	};
	ascii(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, count, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * count * 2, true);
	view.setUint16(32, count * 2, true);
	view.setUint16(34, 16, true);
	ascii(36, 'data');
	view.setUint32(40, dataBytes, true);
	let at = 44;
	for (let f = 0; f < frames; f++) {
		for (let c = 0; c < count; c++) {
			const s = Math.max(-1, Math.min(1, channels[c][f]));
			view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
			at += 2;
		}
	}
	return out;
}

/** Bytes a WAV of `seconds` takes at the trim's rate, in stereo. */
export function wavBytesFor(seconds: number): number {
	return 44 + Math.ceil(seconds * TRIM_SAMPLE_RATE) * 2 * 2;
}

/** `bytes` from `start` to `end` seconds, as a WAV. */
export async function trimToWav(
	bytes: ArrayBuffer,
	start: number,
	end: number,
	decode: DecodeSong = decodeSong
): Promise<Uint8Array> {
	const channels = await decode(bytes);
	if (channels.length === 0) throw new Error('the song has no audio channels');
	return encodeWav(cutChannels(channels, TRIM_SAMPLE_RATE, start, end), TRIM_SAMPLE_RATE);
}
