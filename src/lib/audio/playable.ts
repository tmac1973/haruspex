/**
 * A source an `<audio>` element can actually play.
 *
 * The desktop webview can't play media from a custom URI scheme: WebKitGTK
 * 2.54 answers `haruspex-audio://` with MEDIA_ERR_SRC_NOT_SUPPORTED, Range or
 * no Range, while the same bytes play from a `blob:` URL (measured
 * 2026-10-25). Pictures are unaffected; they don't go through GStreamer. So
 * the desktop reads a song's bytes over IPC (`audio_read_bytes`) and plays a
 * blob of them. The web client plays Settings → Remote control's HTTP route
 * directly, which needs no help.
 *
 * `AudioPlayer` loads every player's song through here.
 */

import { invoke } from '@tauri-apps/api/core';
import { audioSrc } from '#lib/audio/url.ts';

const WEB = import.meta.env.VITE_HARUSPEX_WEB === '1';

/** A song ready for a player: its blob URL and its type. */
export interface PlayableSong {
	url: string;
	mime: string;
}

/** One blob URL per song for the life of the window: re-renders reuse it. */
const songs = new Map<string, Promise<PlayableSong>>();

/** The type of an audio file from its first bytes, as the cache stores them. */
export function sniffAudioMime(b: Uint8Array): string {
	const ascii = (from: number, n: number) => String.fromCharCode(...b.subarray(from, from + n));
	if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
	if (ascii(0, 4) === 'OggS') return 'audio/ogg';
	if (ascii(0, 4) === 'fLaC') return 'audio/flac';
	return 'audio/mpeg';
}

/** A song's bytes: over IPC on the desktop, the HTTP route on the web client. */
async function songBytes(hash: string): Promise<ArrayBuffer> {
	if (!WEB) return invoke<ArrayBuffer>('audio_read_bytes', { hash });
	const r = await fetch(audioSrc(hash) ?? '', { credentials: 'same-origin' });
	if (!r.ok) throw new Error(`Audio not found (${r.status})`);
	return r.arrayBuffer();
}

/**
 * A cached song as a blob the player can load, by hash. The web client could
 * play its route directly, but a blob gives Save as a file to hand over, and
 * its type, there as on the desktop.
 */
export function playableSong(hash: string): Promise<PlayableSong> {
	let song = songs.get(hash);
	if (!song) {
		song = songBytes(hash).then((buf) => {
			const bytes = new Uint8Array(buf);
			const mime = sniffAudioMime(bytes);
			return { url: URL.createObjectURL(new Blob([bytes], { type: mime })), mime };
		});
		// A failure isn't kept: the next player asks again.
		void song.catch(() => songs.delete(hash));
		songs.set(hash, song);
	}
	return song;
}

/** A URL the player can load for a cached song, by hash. */
export async function playableUrl(hash: string): Promise<string> {
	return (await playableSong(hash)).url;
}

/** The file extension for a song's type. */
export function audioExtension(mime: string): string {
	return { 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' }[mime] ?? 'mp3';
}

/** A file name from a song's title: letters, digits and dashes. */
export function songFileName(title: string, mime: string): string {
	const base =
		title
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'song';
	return `${base}.${audioExtension(mime)}`;
}
