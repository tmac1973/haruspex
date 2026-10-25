/**
 * The one place that knows how to address cached audio (`audio_cache` in
 * Rust), as `images/url.ts` is for images: the scheme's base differs by
 * platform, and the web client asks Settings → Remote control's server
 * instead.
 */

import { customSchemeBase } from '#lib/utils/customScheme.ts';

const BASE =
	import.meta.env.VITE_HARUSPEX_WEB === '1' ? '/api/v1/audio/' : customSchemeBase('haruspex-audio');

/** Exactly 64 lowercase hex characters — mirrors `image_cache::is_valid_hash`. */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Either platform's form of a cached-audio URL, with the hash captured.
 * Messages keep whichever form the computer that wrote them uses.
 */
export const LOCAL_AUDIO_URL =
	/^(?:haruspex-audio:\/\/localhost\/|http:\/\/haruspex-audio\.localhost\/)([0-9a-f]{64})$/;

/** URL for cached audio, or `null` if the hash is not the shape Rust accepts. */
export function audioSrc(hash: string): string | null {
	if (!HASH_RE.test(hash)) return null;
	return `${BASE}${hash}`;
}

/** The hash in one of our own audio URLs, or `null` for any other URL. */
export function audioHashFromUrl(url: string): string | null {
	return url.trim().match(LOCAL_AUDIO_URL)?.[1] ?? null;
}
