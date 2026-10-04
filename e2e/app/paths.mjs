/** Where the real-app tests find things. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The test build's identifier: its data lives apart from the user's Haruspex. */
export const E2E_ID = 'com.haruspex.app.e2e';
/**
 * Its own target dir, so swapping in stub sidecars never touches a dev build.
 * The test machines' agent points it into its cache (E2E_TARGET_DIR), because
 * the source tree there is replaced on every run.
 */
export const TARGET = process.env.E2E_TARGET_DIR ?? join(ROOT, 'src-tauri', 'target-e2e');
export const BIN_DIR = join(TARGET, 'debug');
/** Where the stub sidecars write their pids (E2E_STUB_PIDS). */
export const STUB_PIDS = join(tmpdir(), 'haruspex-e2e-stub-pids');

const exe = process.platform === 'win32' ? '.exe' : '';
export function appBinary() {
	return join(BIN_DIR, `haruspex${exe}`);
}
export function stubBinary() {
	return join(TARGET, `sidecar-stub${exe}`);
}
/** The sidecars the app can start, by the names Tauri gives them next to the app. */
export const SIDECARS = ['llama-server', 'whisper-server', 'koko', 'sd-server'].map(
	(n) => `${n}${exe}`
);
