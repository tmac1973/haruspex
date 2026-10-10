/**
 * Code sessions in native Windows folders, with PowerShell (phase 11, #396:
 * `plan/code-tab/phase-11-windows-native.md`). Behind a dev-build flag
 * until the phase's last milestone, as phase 10 was: dev builds offer
 * "This PC" in the new-session dialog, releases don't yet.
 *
 * Read on every call rather than once, so a test can stub `DEV`.
 */
export function nativeWindowsCode(): boolean {
	return import.meta.env.DEV === true;
}
