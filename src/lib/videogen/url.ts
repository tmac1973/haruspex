/**
 * Addressing a generated clip. Clips live in the audio cache (`audio_cache`
 * in Rust), by hash; their own scheme name only tells an answer to show a
 * video player rather than a song's. The web client asks Settings → Remote
 * control's server, whose audio route serves any cached file.
 */

import { mediaUrls } from '#lib/utils/mediaUrl.ts';

const urls = mediaUrls('haruspex-video', '/api/v1/audio/');

/** Either platform's form of a clip's URL, with the hash captured. */
export const LOCAL_VIDEO_URL = urls.pattern;

/** URL for a cached clip, or `null` if the hash is not the shape Rust accepts. */
export const videoSrc = urls.src;

/** The hash in one of our clip URLs, or `null` for any other URL. */
export const videoHashFromUrl = urls.hashFromUrl;
