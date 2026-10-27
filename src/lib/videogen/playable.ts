/**
 * A clip a `<video>` element can play. As for songs (`audio/playable.ts`),
 * the desktop webview won't play media from a custom scheme, so the desktop
 * reads the clip's bytes over IPC and plays a `blob:` URL; the web client
 * fetches Settings → Remote control's route.
 */

import { invoke } from '@tauri-apps/api/core';
import { videoSrc } from '#lib/videogen/url.ts';

const WEB = import.meta.env.VITE_HARUSPEX_WEB === '1';

export interface PlayableClip {
	url: string;
	mime: string;
}

/** One blob URL per clip for the life of the window. */
const clips = new Map<string, Promise<PlayableClip>>();

/** A video file's type from its first bytes: MP4 has `ftyp` at 4, WebM is anything else here. */
export function sniffVideoMime(b: Uint8Array): string {
	return String.fromCharCode(...b.subarray(4, 8)) === 'ftyp' ? 'video/mp4' : 'video/webm';
}

async function clipBytes(hash: string): Promise<ArrayBuffer> {
	if (!WEB) return invoke<ArrayBuffer>('audio_read_bytes', { hash });
	const r = await fetch(videoSrc(hash) ?? '', { credentials: 'same-origin' });
	if (!r.ok) throw new Error(`Video not found (${r.status})`);
	return r.arrayBuffer();
}

/** A cached clip as a blob the player can load, by hash. */
export function playableClip(hash: string): Promise<PlayableClip> {
	let clip = clips.get(hash);
	if (!clip) {
		clip = clipBytes(hash).then((buf) => {
			const bytes = new Uint8Array(buf);
			const mime = sniffVideoMime(bytes);
			return { url: URL.createObjectURL(new Blob([bytes], { type: mime })), mime };
		});
		// A failure isn't kept: the next player asks again.
		void clip.catch(() => clips.delete(hash));
		clips.set(hash, clip);
	}
	return clip;
}

/** A file name from a clip's title: letters, digits and dashes. */
export function clipFileName(title: string, mime: string): string {
	const base =
		title
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'clip';
	return `${base}.${mime === 'video/mp4' ? 'mp4' : 'webm'}`;
}
