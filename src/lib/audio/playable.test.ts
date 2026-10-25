import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { playableUrl, sniffAudioMime } from './playable';

const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
let made: Blob[] = [];

beforeEach(() => {
	made = [];
	URL.createObjectURL = vi.fn((b: Blob) => {
		made.push(b);
		return `blob:song-${made.length}`;
	});
	tauri.invoke.mockReset().mockImplementation(async (_cmd: string, args: { hash: string }) => {
		if (args.hash === 'f'.repeat(64)) throw 'Audio not found';
		return new Uint8Array([0xff, 0xfb, 0x90]).buffer;
	});
});

describe('sniffAudioMime', () => {
	it('reads the types the cache stores from their first bytes', () => {
		expect(sniffAudioMime(bytes('RIFF\0\0\0\0WAVEfmt '))).toBe('audio/wav');
		expect(sniffAudioMime(bytes('OggS\0'))).toBe('audio/ogg');
		expect(sniffAudioMime(bytes('fLaC\0'))).toBe('audio/flac');
		expect(sniffAudioMime(bytes('ID3\x04'))).toBe('audio/mpeg');
		expect(sniffAudioMime(new Uint8Array([0xff, 0xfb]))).toBe('audio/mpeg');
	});
});

describe('playableUrl', () => {
	it('plays a blob of the song, read once per song', async () => {
		const hash = 'a'.repeat(64);
		expect(await playableUrl(hash)).toBe('blob:song-1');
		expect(await playableUrl(hash)).toBe('blob:song-1');
		expect(tauri.invoke).toHaveBeenCalledTimes(1);
		expect(tauri.invoke).toHaveBeenCalledWith('audio_read_bytes', { hash });
		expect(made[0].type).toBe('audio/mpeg');
	});

	it('asks again after a failure', async () => {
		const gone = 'f'.repeat(64);
		await expect(playableUrl(gone)).rejects.toBe('Audio not found');
		await expect(playableUrl(gone)).rejects.toBe('Audio not found');
		expect(tauri.invoke).toHaveBeenCalledTimes(2);
	});
});
