/**
 * The one place that knows how to address a cached image.
 *
 * The scheme's base URL differs by platform (see `customSchemeBase`), and
 * getting it wrong does not fail loudly, so every caller goes through here
 * and stays platform-agnostic.
 *
 * The hash goes in the path rather than the host because a DNS label caps at
 * 63 characters and a sha256 hex digest is 64. Tauri's own `asset://localhost/`
 * scheme uses the same shape. See `image_cache::protocol` for the Rust side.
 *
 * The web client (`src/web/`, built with `VITE_HARUSPEX_WEB`) is another
 * computer's browser, which has no such scheme: it asks Settings → Remote
 * control's server for the same image by hash.
 */

import { customSchemeBase } from '#lib/utils/customScheme.ts';

const BASE =
	import.meta.env.VITE_HARUSPEX_WEB === '1' ? '/api/v1/image/' : customSchemeBase('haruspex-img');

/** Exactly 64 lowercase hex characters — mirrors `image_cache::is_valid_hash`. */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * URL for a cached image, or `null` if the hash is not the shape the protocol
 * handler accepts.
 *
 * Returning `null` rather than a malformed URL keeps a bad value from reaching
 * an `<img src>`, where it would surface as a broken image rather than as the
 * programming error it is.
 */
export function imageSrc(hash: string): string | null {
	if (!HASH_RE.test(hash)) return null;
	return `${BASE}${hash}`;
}
