/**
 * Where a sandboxed page loads the bundled Three.js kit from: the app's own
 * origin, which the artifact policy's `script-src` allows
 * (`src-tauri/src/artifact_frame.rs`).
 */
export function threeKitUrl(origin = globalThis.location?.origin ?? ''): string {
	return new URL('/helpers/three-kit.js', origin).href;
}
