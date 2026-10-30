/**
 * Whether a Code or Shell turn is running. Turning lean mode on hides the
 * tools such a turn may be using, so the Settings switch and the notice wait
 * for it. Turning lean mode off never waits.
 */
import { getOpenSessions } from '#lib/stores/code.svelte.ts';
import { anyShellTurnRunning } from '#lib/stores/shell.svelte.ts';

export const LEAN_BUSY_TITLE = 'Finish or stop the Code and Shell turns first.';

export function codeOrShellBusy(): boolean {
	return getOpenSessions().some((s) => s.status !== 'idle') || anyShellTurnRunning();
}
