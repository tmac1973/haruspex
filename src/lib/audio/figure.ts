/**
 * The HTML for generated audio in an answer: a native `<audio>` player for one
 * of the cache's own URLs, as `images/figure.ts` builds a picture's figure.
 * The model writes `![title](haruspex-audio://localhost/<hash>)`, the image
 * syntax, because that is the one it already uses for what a tool made.
 */

import { audioHashFromUrl, audioSrc } from '#lib/audio/url.ts';

function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * The player for `url`, or `null` when it is not one of our audio URLs. On the
 * web client the source is Settings → Remote control's route for the same
 * hash; on the desktop it is left to `installAudioSources` (`playable.ts`),
 * since the webview can't play the cache's own scheme.
 */
export function audioFigureHtml(url: string, title: string): string | null {
	const hash = audioHashFromUrl(url);
	if (!hash || !audioSrc(hash)) return null;
	const src =
		import.meta.env.VITE_HARUSPEX_WEB === '1' ? ` src="${esc(audioSrc(hash) ?? '')}"` : '';
	const caption = title.trim()
		? `<figcaption class="chat-audio-title">${esc(title.trim())}</figcaption>`
		: '';
	return (
		`<figure class="chat-audio">` +
		`<audio controls preload="metadata" data-audio-hash="${hash}"${src}></audio>` +
		caption +
		`</figure>`
	);
}
