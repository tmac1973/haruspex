/**
 * Tracks which Shell PTY sessions are currently being driven by the coding
 * agent (it has injected a command and is waiting for it to finish), and the
 * command it's running. The Terminal swallows user keystrokes for a busy
 * session so they can't interleave with the agent's command and corrupt the
 * output capture, and shows the running command so the lock reads as "the
 * agent is working", not "the app froze".
 *
 * Keyed by session id and reactive, so the terminal + indicator update the
 * moment a run starts/ends.
 */

import { SvelteMap } from 'svelte/reactivity';

const busy = new SvelteMap<number, string>();

/** Mark a session busy with `command`, or pass `null` to clear it. */
export function setPtyBusy(sessionId: number, command: string | null): void {
	if (command !== null) busy.set(sessionId, command);
	else busy.delete(sessionId);
}

export function isPtyBusy(sessionId: number | null | undefined): boolean {
	return sessionId != null && busy.has(sessionId);
}

/** The command the agent is currently running in this session, if any. */
export function ptyBusyCommand(sessionId: number | null | undefined): string | null {
	return sessionId != null ? (busy.get(sessionId) ?? null) : null;
}
