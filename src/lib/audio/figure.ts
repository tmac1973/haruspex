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
 * web client the source is Settings → Remote control's route for the same hash.
 */
export function audioFigureHtml(url: string, title: string): string | null {
	const hash = audioHashFromUrl(url);
	const src = hash ? audioSrc(hash) : null;
	if (!src) return null;
	const caption = title.trim()
		? `<figcaption class="chat-audio-title">${esc(title.trim())}</figcaption>`
		: '';
	return (
		`<figure class="chat-audio">` +
		`<audio controls preload="metadata" src="${esc(src)}"></audio>` +
		caption +
		`</figure>`
	);
}
