/**
 * A folder the loopback media server (`media_http.rs`) serves for as long as
 * a player needs it: an editor window's folder, or a render's. Only files
 * inside a registered folder can be played, and only until it is released.
 */
import { invoke } from '@tauri-apps/api/core';

export interface MediaRoot {
	/** The URL a `<video>` plays `relPath` (inside the folder) from. */
	url(relPath: string): Promise<string>;
	release(): void;
}

export async function openMediaRoot(path: string): Promise<MediaRoot> {
	const id = await invoke<string>('media_root_register', { path });
	let released = false;
	return {
		url: (relPath) => invoke<string>('media_url', { root: id, relPath }),
		release: () => {
			if (released) return;
			released = true;
			void invoke('media_root_release', { id }).catch(() => {});
		}
	};
}

/** What to say when the webview can't play a video. */
export function cannotPlay(name: string): string {
	const linux = typeof navigator !== 'undefined' && /Linux/.test(navigator.userAgent);
	const mp4 = /\.(mp4|m4v|mov)$/i.test(name);
	return linux && mp4
		? `Could not play ${name}: this system has no decoder for it. On Linux, MP4 needs GStreamer's gst-libav.`
		: `Could not play ${name}: this system has no decoder for it.`;
}
