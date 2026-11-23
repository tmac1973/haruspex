/**
 * The one place that knows how to address cached audio (`audio_cache` in
 * Rust), as `images/url.ts` is for images: the scheme's base differs by
 * platform, and the web client asks Settings → Remote control's server
 * instead. Messages keep whichever URL form the computer that wrote them uses.
 */

import { mediaUrls } from '#lib/utils/mediaUrl.ts';

const urls = mediaUrls('haruspex-audio', '/api/v1/audio/');

/** Either platform's form of a cached-audio URL, with the hash captured. */
export const LOCAL_AUDIO_URL = urls.pattern;

/** URL for cached audio, or `null` if the hash is not the shape Rust accepts. */
export const audioSrc = urls.src;

/** The hash in one of our own audio URLs, or `null` for any other URL. */
export const audioHashFromUrl = urls.hashFromUrl;
