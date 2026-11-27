/**
 * Memory-cap kills for commands run_command backgrounded in a Shell tab's
 * terminal.
 *
 * A foreground command reads the terminal's `oom_kill` count before and after
 * it runs (`withOomNote` in `_ptyExec.ts`). A background one outlives the
 * call that started it, so the count taken at its start is kept and compared
 * when it is seen to finish: by its watch (`backgroundWatch.ts`), or, for one
 * started without watch, when the model reads its log with fs_read_text.
 *
 * The whole terminal shares one ceiling, so a kill is only put down to the
 * command when it also failed. Free of store imports, like
 * `backgroundWatch.ts`.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ShellMemoryStatus } from '#lib/ipc/gen/ShellMemoryStatus.ts';
import { outOfMemoryNote } from '#lib/shell/memoryLimit.ts';

/** The terminal's ceiling and kill count, or null without a ceiling. */
export async function shellMemoryStatus(sessionId: number): Promise<ShellMemoryStatus | null> {
	try {
		return await invoke<ShellMemoryStatus | null>('shell_memory_status', { sessionId });
	} catch {
		return null;
	}
}

/**
 * The terminal's ceiling in MB when a command that started at kill count
 * `killsAtStart` and exited with `exitCode` was killed for going over it;
 * null when it wasn't (or that can't be told).
 */
export async function killedForMemory(
	sessionId: number,
	killsAtStart: number | undefined,
	exitCode: number
): Promise<number | null> {
	if (killsAtStart == null || exitCode === 0) return null;
	const now = await shellMemoryStatus(sessionId);
	return now && now.oomKills > killsAtStart ? now.limitMb : null;
}

interface Unwatched {
	ptySessionId: number;
	logPath: string;
	donePath: string;
	wslDistro?: string;
	killsAtStart: number;
}

/** Background commands started without watch, by log path, until a kill is reported. */
const unwatched = new Map<string, Unwatched>();

/** Remember a background command started without watch, so a read of its log can report a kill. */
export function trackUnwatched(info: Unwatched): void {
	unwatched.set(info.logPath, info);
}

/** Forget a session's background commands — called when its tab closes. */
export function forgetUnwatchedForSession(ptySessionId: number): void {
	for (const [path, u] of unwatched) if (u.ptySessionId === ptySessionId) unwatched.delete(path);
}

/**
 * The out-of-memory note for a read of `path`, when it is the log of an
 * unwatched background command that has finished after a memory-cap kill.
 * Given once; a command still running, or one that ended any other way,
 * gets null.
 */
export async function unwatchedOomNote(path: string): Promise<string | null> {
	const u = unwatched.get(path);
	if (!u) return null;
	let done: string;
	try {
		done = await invoke<string>('fs_read_text_absolute', {
			path: u.donePath,
			wslDistro: u.wslDistro
		});
	} catch {
		return null; // still running
	}
	const code = Number.parseInt(done.trim(), 10);
	if (Number.isNaN(code)) return null;
	unwatched.delete(path);
	const limitMb = await killedForMemory(u.ptySessionId, u.killsAtStart, code);
	if (limitMb == null) return null;
	return `This log is from a background command that has exited (exit code ${code}). ${outOfMemoryNote(
		{ out_of_memory: true, memory_limit_mb: limitMb }
	)}`;
}

/** Test-only: reset module state between cases. */
export function _resetForTests(): void {
	unwatched.clear();
}
