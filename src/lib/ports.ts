/**
 * Localhost ports for the bundled sidecars.
 *
 * Single source of truth on the frontend side. These MUST match the Rust
 * `ports` module in `src-tauri/src/sidecar_utils.rs` — there's no codegen
 * across the IPC boundary, so the two are kept in sync by hand. Importing
 * from here means a port change touches one TS line instead of several
 * scattered literals.
 */
export const PORTS = {
	llama: 8765,
	whisper: 8766,
	tts: 3001
} as const;

/** Loopback host the sidecars bind to. Mirrors the Rust `LOOPBACK` const. */
export const LOOPBACK = '127.0.0.1';

/** `http://127.0.0.1:<port>` — base URL for a sidecar's local HTTP API. */
export function baseUrl(port: number): string {
	return `http://${LOOPBACK}:${port}`;
}
