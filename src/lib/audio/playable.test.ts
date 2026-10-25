import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { installAudioSources, playableUrl, sniffAudioMime } from './playable';
import { renderMarkdown } from '#lib/markdown.ts';

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

describe('installAudioSources', () => {
	it('gives an answer’s player its song, including one rendered later', async () => {
		const hash = 'b'.repeat(64);
		const html = renderMarkdown(`![Song](haruspex-audio://localhost/${hash})`);
		// The desktop's markdown leaves the source to the loader.
		expect(html).toContain(`data-audio-hash="${hash}"`);
		expect(html).not.toContain(' src=');

		document.body.innerHTML = html;
		const stop = installAudioSources(document);
		const first = document.querySelector('audio')!;
		await vi.waitFor(() => expect(first.getAttribute('src')).toMatch(/^blob:song-/));

		const later = document.createElement('div');
		later.innerHTML = html;
		document.body.append(later);
		const second = later.querySelector('audio')!;
		await vi.waitFor(() => expect(second.getAttribute('src')).toBe(first.getAttribute('src')));
		stop();
	});

	it('says on the player when the song has gone', async () => {
		document.body.innerHTML = `<audio data-audio-hash="${'f'.repeat(64)}"></audio>`;
		const stop = installAudioSources(document);
		const audio = document.querySelector('audio')!;
		await vi.waitFor(() => expect(audio.title).toMatch(/no longer in the audio cache/));
		expect(audio.getAttribute('src')).toBeNull();
		stop();
	});
});
