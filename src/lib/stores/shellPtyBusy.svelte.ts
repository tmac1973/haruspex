/**
 * Tracks which Shell PTY sessions are currently being driven by the coding
 * agent (it has injected a command and is waiting for it to finish). The
 * Terminal swallows user keystrokes for a busy session so they can't
 * interleave with the agent's command and corrupt the output capture.
 *
 * Keyed by session id and reactive, so the terminal + an indicator update
 * the moment a run starts/ends.
 */

import { SvelteSet } from 'svelte/reactivity';

const busy = new SvelteSet<number>();

export function setPtyBusy(sessionId: number, isBusy: boolean): void {
	if (isBusy) busy.add(sessionId);
	else busy.delete(sessionId);
}

export function isPtyBusy(sessionId: number | null | undefined): boolean {
	return sessionId != null && busy.has(sessionId);
}
