/**
 * Tracks background commands started with run_command's `watch` option and
 * notifies when they finish.
 *
 * A watched command is backgrounded in the live PTY (see runInPtyBackground)
 * with its exit code written to a `.done` sentinel file on completion. We poll
 * those sentinels off the terminal (a plain absolute-path file read, so it
 * never pollutes the shell) and, when one appears, hand the completion to the
 * registered handler. The shell store wires that handler to queue a follow-up
 * agent turn for the owning session once it's idle — "wait for an opportunity"
 * rather than interrupting an in-flight turn.
 *
 * This module is deliberately decoupled from the shell store (no imports of it)
 * so the run_command tool can register watches without an import cycle.
 */

import { invoke } from '@tauri-apps/api/core';

export interface BackgroundWatch {
	id: string;
	/** The PTY session the command runs in (ShellSession.boundSessionId). */
	ptySessionId: number;
	command: string;
	logPath: string;
	donePath: string;
	startedAtMs: number;
	/** Set once the .done sentinel is observed. */
	exitCode?: number;
	completedAtMs?: number;
}

const POLL_MS = 4000;

let watches: BackgroundWatch[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let counter = 0;
let onComplete: ((ptySessionId: number) => void) | null = null;

/** Wire the "a watch finished" callback (the shell store dispatches by session). */
export function setWatchCompletionHandler(fn: (ptySessionId: number) => void): void {
	onComplete = fn;
}

export function registerWatch(info: {
	ptySessionId: number;
	command: string;
	logPath: string;
	donePath: string;
	startedAtMs: number;
}): string {
	counter += 1;
	const id = `watch-${counter}`;
	watches.push({ id, ...info });
	ensurePolling();
	return id;
}

/** Completed-but-not-yet-consumed watches for a session (does not remove them). */
export function peekCompletedWatches(ptySessionId: number): BackgroundWatch[] {
	return watches.filter((w) => w.ptySessionId === ptySessionId && w.exitCode != null);
}

/** Remove watches by id once their completion has been delivered. */
export function consumeWatches(ids: string[]): void {
	const drop = new Set(ids);
	watches = watches.filter((w) => !drop.has(w.id));
	stopPollingIfIdle();
}

/** Drop every watch for a session — called when the session/tab closes. */
export function clearWatchesForSession(ptySessionId: number): void {
	watches = watches.filter((w) => w.ptySessionId !== ptySessionId);
	stopPollingIfIdle();
}

/** Read a watched command's captured output (its temp log). Empty on failure. */
export async function readWatchLog(logPath: string): Promise<string> {
	try {
		return await invoke<string>('fs_read_text_absolute', { path: logPath });
	} catch {
		return '';
	}
}

function ensurePolling(): void {
	if (pollTimer !== null || watches.length === 0) return;
	pollTimer = setInterval(() => void tick(), POLL_MS);
}

function stopPollingIfIdle(): void {
	// Keep polling while any watch is still running; once all are done (consumed)
	// or gone, stop the timer so we don't spin forever.
	if (pollTimer !== null && !watches.some((w) => w.exitCode == null)) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

async function tick(): Promise<void> {
	if (polling) return;
	polling = true;
	try {
		const running = watches.filter((w) => w.exitCode == null);
		for (const w of running) {
			let content: string;
			try {
				content = await invoke<string>('fs_read_text_absolute', { path: w.donePath });
			} catch {
				continue; // sentinel not written yet — still running
			}
			const code = Number.parseInt(content.trim(), 10);
			if (Number.isNaN(code)) continue;
			w.exitCode = code;
			w.completedAtMs = Date.now();
			onComplete?.(w.ptySessionId);
		}
		stopPollingIfIdle();
	} finally {
		polling = false;
	}
}

/** Test-only: reset module state between cases. */
export function _resetForTests(): void {
	if (pollTimer !== null) clearInterval(pollTimer);
	pollTimer = null;
	watches = [];
	polling = false;
	counter = 0;
	onComplete = null;
}
