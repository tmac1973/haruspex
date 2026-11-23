/**
 * Addressing a file in one of the Rust caches by its sha256 hash, through a
 * custom scheme (`haruspex-img`, `haruspex-audio`, …) whose base differs by
 * platform, or, in the web client, a route on Settings → Remote control's
 * server. `images/url.ts`, `audio/url.ts` and `videogen/url.ts` are each one
 * of these.
 */

import { isWebClient } from '#lib/buildFlags.ts';
import { customSchemeBase } from '#lib/utils/customScheme.ts';

/** Exactly 64 lowercase hex characters — mirrors `image_cache::is_valid_hash`. */
const HASH_RE = /^[0-9a-f]{64}$/;

export interface MediaUrls {
	/** Either platform's scheme form of a URL, with the hash captured. */
	pattern: RegExp;
	/** The URL for `hash`, or `null` when it is not the shape Rust accepts. */
	src(hash: string): string | null;
	/** The hash in one of these URLs, or `null` for any other URL. */
	hashFromUrl(url: string): string | null;
}

/**
 * `webRoute` is where the web client asks for the file. `hashFromUrl` only
 * accepts it when `acceptWebRoute` is set: audio and video share one route,
 * so a route URL alone can't say which of them it is.
 */
export function mediaUrls(
	scheme: string,
	webRoute: string,
	{ acceptWebRoute = false } = {}
): MediaUrls {
	const base = isWebClient ? webRoute : customSchemeBase(scheme);
	const forms = [`${scheme}://localhost/`, `http://${scheme}.localhost/`];
	const quote = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
	const either = (list: string[]) => new RegExp(`^(?:${list.map(quote).join('|')})([0-9a-f]{64})$`);
	const pattern = either(forms);
	const accepted = acceptWebRoute ? either([...forms, webRoute]) : pattern;
	return {
		pattern,
		src: (hash) => (HASH_RE.test(hash) ? `${base}${hash}` : null),
		hashFromUrl: (url) => url.trim().match(accepted)?.[1] ?? null
	};
}
