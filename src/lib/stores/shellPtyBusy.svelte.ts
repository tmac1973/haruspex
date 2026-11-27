/**
 * Tracks which Shell PTY sessions are currently being driven by the coding
 * agent (it has injected a command and is waiting for it to finish), and the
 * command it's running. Drives the "agent running: <cmd>" badge so the takeover
 * reads as the agent working, not the app freezing.
 *
 * NOTE: this does NOT block user input — the user can still type into the
 * running command (e.g. a sudo password / interactive prompt). The agent is
 * prevented from injecting a *second* command mid-run by the busy-guard in
 * pty-exec, not by this store.
 *
 * Keyed by session id and reactive, so the indicator updates the moment a run
 * starts/ends.
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

/**
 * Sessions whose agent command is waiting at a password or passphrase prompt
 * (see `shell/secretPrompt.ts`), with the prompt line. The terminal shows
 * "Type your password in the terminal" and takes focus while it's set.
 */
const secretWait = new SvelteMap<number, string>();

export function setSecretWait(sessionId: number, prompt: string | null): void {
	if (prompt !== null) secretWait.set(sessionId, prompt);
	else secretWait.delete(sessionId);
}

export function secretWaitPrompt(sessionId: number | null | undefined): string | null {
	return sessionId != null ? (secretWait.get(sessionId) ?? null) : null;
}
