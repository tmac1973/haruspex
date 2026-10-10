/**
 * The shell side of `code/shellBridge.ts`: open a new Shell tab at a folder,
 * type a command at its prompt without pressing Enter, show it, and
 * optionally wait for the user to run it.
 *
 * Kept out of the shell store so it can be tested without one: the store
 * registers it with the few registry operations it needs (`OpenerDeps`).
 *
 * Waiting works like `ShellPane`'s Run: the shell integration counts every
 * finished command (`completed_total`), so a rise past the count taken before
 * the paste is the user's command finishing, and the newest captured region
 * holds what actually ran. The tab closing, or its shell exiting, ends the
 * wait as "closed".
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { sleep } from '#lib/utils/async.ts';
import { toPtyPaste } from './commandBlock';
import type { ShellCommandRequest, ShellCommandResult } from '#lib/code/shellBridge.ts';
import type { ShellSelection } from '#lib/ipc/gen/ShellSelection.ts';

/** The parts of a `ShellSession` this needs. */
export interface OpenedSession {
	readonly id: string;
	readonly name: string;
	initialCwd: string | null;
	initialSelection: ShellSelection | null;
	/** The PTY, once the pane's terminal has spawned it. */
	readonly boundSessionId: number | null;
}

export interface OpenerDeps {
	/** A new session in the main window's registry. */
	create: () => OpenedSession;
	/** Still in the registry (not closed, not detached). */
	isOpen: (id: string) => boolean;
	/** Make it the active shell and show the Shell tab. */
	show: (id: string) => void;
}

interface ShellCtx {
	completed_total: number;
	marker_total: number;
}

interface CapturedRegion {
	commandLine: string;
	output: string;
	exitCode: number | null;
	cwd: string | null;
	pending?: boolean;
}

export const POLL_MS = 150;
/** How long the pane gets to mount and spawn its PTY. */
export const SPAWN_TIMEOUT_MS = 15_000;
/**
 * How long the new shell gets to draw its first prompt through the hook. A
 * slow `~/.bashrc` is the usual wait; a shell with no hook never draws one.
 */
export const INTEGRATION_TIMEOUT_MS = 5_000;

type Outcome<T> = { ok: T } | { stop: ShellCommandResult };

export async function openForCommand(
	req: ShellCommandRequest,
	deps: OpenerDeps
): Promise<ShellCommandResult> {
	const session = deps.create();
	// Read once, when the pane's terminal spawns the PTY.
	session.initialCwd = req.cwd;
	if (req.wslDistro) session.initialSelection = { kind: 'wsl', distro: req.wslDistro };
	deps.show(session.id);
	const shellName = session.name;
	const closed: Outcome<never> = { stop: { kind: 'closed', shellName } };
	const poll = <T>(timeoutMs: number, onTimeout: Outcome<T>, check: Check<T>) =>
		until(req.signal, timeoutMs, check, onTimeout, { kind: 'aborted', shellName });

	// The pane mounts on the tab switch above; its terminal binds the PTY.
	const spawned = await poll<number>(
		SPAWN_TIMEOUT_MS,
		{ stop: { kind: 'unavailable', message: `${shellName} didn't start in time.` } },
		() => {
			if (!deps.isOpen(session.id)) return closed;
			const pty = session.boundSessionId;
			return pty != null ? { ok: pty } : null;
		}
	);
	if ('stop' in spawned) return spawned.stop;
	const ptyId = spawned.ok;

	const exit = await watchExit(ptyId);
	try {
		// Null on timeout: a shell with no hook never draws a marked prompt.
		const ready = await poll<ShellCtx | null>(INTEGRATION_TIMEOUT_MS, { ok: null }, async () => {
			if (exit.exited || !deps.isOpen(session.id)) return closed;
			const ctx = await context(ptyId);
			if (!ctx) return closed;
			return ctx.marker_total > 0 ? { ok: ctx } : null;
		});
		if ('stop' in ready) return ready.stop;
		// A fresh shell at its prompt: bracketed paste is what its line editor reads.
		await invoke('shell_write', { sessionId: ptyId, data: toPtyPaste(req.command) });
		req.onOpened?.({ name: shellName, focus: () => deps.show(session.id) });
		if (!req.wait || !ready.ok) return { kind: 'opened', shellName, integration: !!ready.ok };

		const before = ready.ok.completed_total;
		const pastedAt = Date.now();
		const done = await poll<true>(Infinity, closed, async () => {
			if (exit.exited) return closed;
			// A detached tab leaves the registry but keeps its PTY: follow the PTY.
			const ctx = await context(ptyId);
			if (!ctx) return closed;
			return ctx.completed_total > before ? { ok: true } : null;
		});
		if ('stop' in done) return done.stop;
		return completed(shellName, req.command, await lastRegion(ptyId), Date.now() - pastedAt);
	} finally {
		exit.stop();
	}
}

/** What ran, from the newest captured region (the typed command if none). */
function completed(
	shellName: string,
	typed: string,
	region: CapturedRegion | null,
	durationMs: number
): ShellCommandResult {
	return {
		kind: 'completed',
		shellName,
		command: region?.commandLine.trim() || typed,
		exitCode: region?.exitCode ?? null,
		output: region?.output ?? '',
		cwd: region?.cwd ?? null,
		durationMs
	};
}

/**
 * Exit is the one ending polling can't see: an exited shell's PTY stays
 * registered until its tab closes.
 */
async function watchExit(ptyId: number): Promise<{ readonly exited: boolean; stop: () => void }> {
	const state = { exited: false, stop: () => {} };
	try {
		state.stop = await listen<{ session_id: number }>('shell://exit', (e) => {
			if (e.payload.session_id === ptyId) state.exited = true;
		});
	} catch {
		// No event bus (a test, a closing window): closing the tab still ends it.
	}
	return state;
}

/** The PTY's counters, or null once it is gone. */
async function context(ptyId: number): Promise<ShellCtx | null> {
	try {
		return await invoke<ShellCtx>('shell_get_context', { sessionId: ptyId });
	} catch {
		return null;
	}
}

/** The newest finished command's region. */
async function lastRegion(ptyId: number): Promise<CapturedRegion | null> {
	try {
		const regions = await invoke<CapturedRegion[]>('shell_get_recent_commands', {
			sessionId: ptyId,
			limit: 1
		});
		return regions.filter((r) => !r.pending).pop() ?? null;
	} catch {
		return null;
	}
}

type Check<T> = () => Outcome<T> | null | Promise<Outcome<T> | null>;

/**
 * Poll `check` (first at once, then every POLL_MS) until it settles; the
 * signal firing gives `aborted`, and `timeoutMs` passing gives `onTimeout`.
 */
async function until<T>(
	signal: AbortSignal | undefined,
	timeoutMs: number,
	check: Check<T>,
	onTimeout: Outcome<T>,
	aborted: ShellCommandResult
): Promise<Outcome<T>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (signal?.aborted) return { stop: aborted };
		const out = await check();
		if (signal?.aborted) return { stop: aborted };
		if (out) return out;
		if (Date.now() >= deadline) return onTimeout;
		await sleep(POLL_MS);
	}
}
