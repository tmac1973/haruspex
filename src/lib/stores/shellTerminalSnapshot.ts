/**
 * Registry mapping a live PTY session id to a function that rasterizes its
 * terminal to a PNG data URL. ShellPane registers the bound terminal handle's
 * snapshot fn on ready and clears it on teardown; the `shell_snapshot` agent
 * tool looks it up by `ctx.shellSessionId` to let the model "see" the terminal.
 *
 * Plain module (no reactivity) — this is a lookup table, not UI state.
 */

type SnapshotFn = () => string | null;

const registry = new Map<number, SnapshotFn>();

export function registerTerminalSnapshot(sessionId: number, fn: SnapshotFn): void {
	registry.set(sessionId, fn);
}

export function clearTerminalSnapshot(sessionId: number): void {
	registry.delete(sessionId);
}

/** Capture the terminal for `sessionId` as a PNG data URL, or null if no
 *  terminal is registered for it (or capture failed). */
export function snapshotTerminal(sessionId: number): string | null {
	const fn = registry.get(sessionId);
	return fn ? fn() : null;
}
