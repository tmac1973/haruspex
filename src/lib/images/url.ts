/**
 * The one place that knows how to address a cached image.
 *
 * Tauri exposes a custom scheme as `http://<scheme>.localhost` on Windows and
 * Android, but as the native `<scheme>://localhost` on Linux (WebKitGTK) and
 * macOS. Getting it wrong does not fail loudly — the request goes to the real
 * network and dies as a connection refusal — so the branch lives here and
 * every caller stays platform-agnostic. The same split is applied to the
 * sandbox's `haruspexfetch:` scheme in `sandbox/python.worker.ts`.
 *
 * The hash goes in the path rather than the host because a DNS label caps at
 * 63 characters and a sha256 hex digest is 64. Tauri's own `asset://localhost/`
 * scheme uses the same shape. See `image_cache::protocol` for the Rust side.
 */

const isWindowsLike = /Windows|Android/i.test(
	(typeof navigator !== 'undefined' && navigator.userAgent) || ''
);

const BASE = isWindowsLike ? 'http://haruspex-img.localhost/' : 'haruspex-img://localhost/';

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
