/**
 * Addressing a generated clip. Clips live in the audio cache (`audio_cache`
 * in Rust), by hash; their own scheme name only tells an answer to show a
 * video player rather than a song's. The web client asks Settings → Remote
 * control's server, whose audio route serves any cached file.
 */

import { customSchemeBase } from '#lib/utils/customScheme.ts';

const BASE =
	import.meta.env.VITE_HARUSPEX_WEB === '1' ? '/api/v1/audio/' : customSchemeBase('haruspex-video');

const HASH_RE = /^[0-9a-f]{64}$/;

/** Either platform's form of a clip's URL, with the hash captured. */
export const LOCAL_VIDEO_URL =
	/^(?:haruspex-video:\/\/localhost\/|http:\/\/haruspex-video\.localhost\/)([0-9a-f]{64})$/;

/** URL for a cached clip, or `null` if the hash is not the shape Rust accepts. */
export function videoSrc(hash: string): string | null {
	return HASH_RE.test(hash) ? `${BASE}${hash}` : null;
}

/** The hash in one of our clip URLs, or `null` for any other URL. */
export function videoHashFromUrl(url: string): string | null {
	return url.trim().match(LOCAL_VIDEO_URL)?.[1] ?? null;
}
