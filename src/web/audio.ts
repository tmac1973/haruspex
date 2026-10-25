/**
 * Audio in an answer, for the web client. A message holds the desktop's own
 * `haruspex-audio:` URL (in either platform's form), which means nothing to
 * this browser; Settings → Remote control's server serves the same file by
 * hash, with Range so the player can seek.
 */
import { audioHashFromUrl } from '#lib/audio/url.ts';

/** The page's URL for one of the desktop's audio URLs, or `null` for any other. */
export function webAudioSrc(url: string): string | null {
	const hash = audioHashFromUrl(url);
	return hash ? `/api/v1/audio/${hash}` : null;
}
