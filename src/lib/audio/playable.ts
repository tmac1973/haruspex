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
 * Players in answers are plain HTML from markdown, so they carry the hash in
 * `data-audio-hash` and {@link installAudioSources} fills in their `src`.
 */

import { invoke } from '@tauri-apps/api/core';
import { audioSrc } from '#lib/audio/url.ts';

const WEB = import.meta.env.VITE_HARUSPEX_WEB === '1';

/** One blob URL per song for the life of the window: re-renders reuse it. */
const urls = new Map<string, Promise<string>>();

/** The type of an audio file from its first bytes, as the cache stores them. */
export function sniffAudioMime(b: Uint8Array): string {
	const ascii = (from: number, n: number) => String.fromCharCode(...b.subarray(from, from + n));
	if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
	if (ascii(0, 4) === 'OggS') return 'audio/ogg';
	if (ascii(0, 4) === 'fLaC') return 'audio/flac';
	return 'audio/mpeg';
}

/** A URL the player can load for a cached song, by hash. */
export function playableUrl(hash: string): Promise<string> {
	if (WEB) return Promise.resolve(audioSrc(hash) ?? '');
	let url = urls.get(hash);
	if (!url) {
		url = invoke<ArrayBuffer>('audio_read_bytes', { hash }).then((buf) => {
			const bytes = new Uint8Array(buf);
			return URL.createObjectURL(new Blob([bytes], { type: sniffAudioMime(bytes) }));
		});
		// A failure isn't kept: the next player asks again.
		url.catch(() => urls.delete(hash));
		urls.set(hash, url);
	}
	return url;
}

/** Give a player its source, or say on it why it has none. */
function fill(audio: HTMLAudioElement): void {
	const hash = audio.dataset.audioHash;
	if (!hash || audio.getAttribute('src') || audio.dataset.audioLoading) return;
	audio.dataset.audioLoading = '1';
	playableUrl(hash)
		.then((url) => {
			audio.src = url;
		})
		.catch((e: unknown) => {
			audio.title = 'This song is no longer in the audio cache.';
			console.warn('Could not load a song for its player:', e);
		})
		.finally(() => delete audio.dataset.audioLoading);
}

/**
 * Fill in every answer's player, now and as answers render. One observer for
 * the document, as markdown is re-rendered while a reply streams.
 */
export function installAudioSources(doc: Document): () => void {
	const scan = (root: ParentNode) =>
		root.querySelectorAll<HTMLAudioElement>('audio[data-audio-hash]').forEach(fill);
	scan(doc);
	const observer = new MutationObserver((records) => {
		for (const r of records) {
			for (const node of r.addedNodes) {
				if (node instanceof HTMLAudioElement) fill(node);
				else if (node instanceof Element) scan(node);
			}
		}
	});
	observer.observe(doc.body, { childList: true, subtree: true });
	return () => observer.disconnect();
}
