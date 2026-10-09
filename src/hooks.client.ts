/**
 * Client hooks.
 *
 * `init` runs before the app starts. In the `e2e` Vite mode only, it replaces
 * Tauri's IPC with the fixture table in `#lib/e2e/installMocks`, so the UI
 * flows run in a plain browser. `import.meta.env.MODE` is a build-time
 * constant: in every other build the branch, and the import with it, is
 * removed — CI greps the production output to make sure. The same goes for
 * the hooks `scripts/drive.mjs` reads, which only a build made with
 * `VITE_HARUSPEX_E2E=1` (`e2e/app/build.mjs`) carries.
 */
import type { HandleClientError } from '@sveltejs/kit/hooks';
import { forwardConsoleToDebugLog, startDebugLogFile } from '#lib/debug-log.ts';

/**
 * What SvelteKit does when no hook is given: log it. Exported because the
 * build looks for it next to `init`, and warns on every build when it is
 * missing.
 */
export const handleError: HandleClientError = ({ error }) => {
	console.error(error);
};

export async function init(): Promise<void> {
	forwardConsoleToDebugLog();
	if (import.meta.env.MODE === 'e2e') {
		const { installMocks } = await import('#lib/e2e/installMocks.ts');
		installMocks();
	} else {
		const { invoke } = await import('@tauri-apps/api/core');
		void startDebugLogFile(invoke);
	}
	if (import.meta.env.VITE_HARUSPEX_E2E === '1') {
		const { installDriveHooks } = await import('#lib/e2e/driveHooks.ts');
		installDriveHooks();
	}
}
