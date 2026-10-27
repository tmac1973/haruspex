/**
 * The HTML for generated audio in an answer: a native `<audio>` player for one
 * of the cache's own URLs, as `images/figure.ts` builds a picture's figure.
 * The model writes `![title](haruspex-audio://localhost/<hash>)`, the image
 * syntax, because that is the one it already uses for what a tool made.
 */

import { audioHashFromUrl } from '#lib/audio/url.ts';
import { videoHashFromUrl } from '#lib/videogen/url.ts';

function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * The placeholder for `url`'s player, or `null` when it is not one of our
 * audio URLs. A generated clip's `haruspex-video:` URL gets a video player's. `installAudioPlayers` (`mountPlayers.ts`) mounts the player:
 * its own controls, and the song loaded so the webview can play it.
 */
export function audioFigureHtml(url: string, title: string): string | null {
	const clip = videoHashFromUrl(url);
	if (clip) {
		return `<div class="chat-video" data-video-hash="${clip}" data-video-title="${esc(title.trim())}"></div>`;
	}
	const hash = audioHashFromUrl(url);
	if (!hash) return null;
	return `<div class="chat-audio" data-audio-hash="${hash}" data-audio-title="${esc(title.trim())}"></div>`;
}
