/**
 * Tracks background commands started with run_command's `watch` option and
 * notifies when they finish.
 *
 * A watch has one of two sources:
 *
 * - **PTY** (Shell Full access): the command is backgrounded in the live PTY
 *   (see runInPtyBackground) with its exit code written to a `.done` sentinel
 *   file on completion. We poll those sentinels off the terminal (a plain
 *   absolute-path file read, so it never pollutes the shell).
 * - **code_bg** (the Code tab, no terminal): the command runs as a Rust-side
 *   background process (`code_bg_start`); we poll `code_bg_status` for it.
 *
 * When one finishes, the completion goes to the handler registered for its
 * owner: the shell store's (by PTY session) or a Code session's (by session
 * id). Each queues a follow-up agent turn once its session is idle — "wait for
 * an opportunity" rather than interrupting an in-flight turn.
 *
 * This module is deliberately decoupled from the stores (no imports of them)
 * so the run_command tool can register watches without an import cycle.
 */

import { invoke } from '@tauri-apps/api/core';
import type { BgProcess } from '#lib/ipc/gen/BgProcess.ts';
import { truncateCapturedOutput } from '#lib/shell/truncate.ts';
import { formatDuration } from '#lib/utils/format.ts';

interface WatchBase {
	id: string;
	command: string;
	logPath: string;
	startedAtMs: number;
	/**
	 * Set once the command is seen to finish. For a code_bg watch, -1 when it
	 * was killed by a signal.
	 */
	exitCode?: number;
	completedAtMs?: number;
}

/** A command backgrounded in a Shell tab's live PTY. */
export interface BackgroundWatch extends WatchBase {
	source: 'pty';
	/** The PTY session the command runs in (ShellSession.boundSessionId). */
	ptySessionId: number;
	donePath: string;
	/** The WSL distro the paths live in, for a WSL session (Windows). */
	wslDistro?: string;
}

/** A Rust-side background process (`code_bg_*`) owned by a Code session. */
export interface CodeBgWatch extends WatchBase {
	source: 'code_bg';
	/** The Code session that owns the process. */
	owner: string;
	/** The `code_bg` process id. */
	processId: string;
}

export type AnyWatch = BackgroundWatch | CodeBgWatch;

const POLL_MS = 4000;

let watches: AnyWatch[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let counter = 0;
let onComplete: ((ptySessionId: number) => void) | null = null;
const codeHandlers = new Map<string, () => void>();

/** Wire the "a watch finished" callback (the shell store dispatches by session). */
export function setWatchCompletionHandler(fn: (ptySessionId: number) => void): void {
	onComplete = fn;
}

/**
 * Wire the "a watch finished" callback for one Code session. Returns a function
 * that removes it.
 */
export function setCodeWatchCompletionHandler(owner: string, fn: () => void): () => void {
	codeHandlers.set(owner, fn);
	return () => {
		if (codeHandlers.get(owner) === fn) codeHandlers.delete(owner);
	};
}

function nextId(): string {
	counter += 1;
	return `watch-${counter}`;
}

export function registerWatch(info: {
	ptySessionId: number;
	command: string;
	logPath: string;
	donePath: string;
	wslDistro?: string;
	startedAtMs: number;
}): string {
	const id = nextId();
	watches.push({ id, source: 'pty', ...info });
	ensurePolling();
	return id;
}

/** Watch a `code_bg` process for its owning Code session. */
export function registerCodeBgWatch(info: {
	owner: string;
	processId: string;
	command: string;
	logPath: string;
	startedAtMs: number;
}): string {
	const id = nextId();
	watches.push({ id, source: 'code_bg', ...info });
	ensurePolling();
	return id;
}

/** Completed-but-not-yet-consumed watches for a session (does not remove them). */
export function peekCompletedWatches(ptySessionId: number): BackgroundWatch[] {
	return watches.filter(
		(w): w is BackgroundWatch =>
			w.source === 'pty' && w.ptySessionId === ptySessionId && w.exitCode != null
	);
}

/** Completed-but-not-yet-consumed watches for a Code session. */
export function peekCompletedCodeWatches(owner: string): CodeBgWatch[] {
	return watches.filter(
		(w): w is CodeBgWatch => w.source === 'code_bg' && w.owner === owner && w.exitCode != null
	);
}

/** Remove watches by id once their completion has been delivered. */
export function consumeWatches(ids: string[]): void {
	const drop = new Set(ids);
	watches = watches.filter((w) => !drop.has(w.id));
	stopPollingIfIdle();
}

/** Drop every watch for a session — called when the session/tab closes. */
export function clearWatchesForSession(ptySessionId: number): void {
	watches = watches.filter((w) => !(w.source === 'pty' && w.ptySessionId === ptySessionId));
	stopPollingIfIdle();
}

/** Drop every watch for a Code session — called when it closes. */
export function clearCodeWatches(owner: string): void {
	watches = watches.filter((w) => !(w.source === 'code_bg' && w.owner === owner));
	stopPollingIfIdle();
}

/**
 * Remove a Code session's watches, finished or not, and return them, for a
 * session that moves to another window (`adoptCodeWatches` there). Watches
 * live in this JS context, and the process they follow lives on in Rust.
 */
export function takeCodeWatches(owner: string): CodeBgWatch[] {
	const taken = watches.filter(
		(w): w is CodeBgWatch => w.source === 'code_bg' && w.owner === owner
	);
	if (taken.length > 0) {
		watches = watches.filter((w) => !taken.includes(w as CodeBgWatch));
		stopPollingIfIdle();
	}
	return taken;
}

/**
 * Take over watches another window handed off (`takeCodeWatches`). Their
 * ids are re-issued here, since each window counts its own.
 */
export function adoptCodeWatches(list: CodeBgWatch[]): void {
	for (const w of list) {
		if (w?.source !== 'code_bg' || typeof w.owner !== 'string') continue;
		watches.push({ ...w, id: nextId() });
	}
	if (watches.some((w) => w.exitCode == null)) ensurePolling();
}

/** Read a watched command's captured output (its temp log). Empty on failure. */
export async function readWatchLog(logPath: string, wslDistro?: string): Promise<string> {
	try {
		return await invoke<string>('fs_read_text_absolute', { path: logPath, wslDistro });
	} catch {
		return '';
	}
}

/** The last `bytes` of a `code_bg` process's log. Empty on failure. */
export async function readCodeBgLog(processId: string, bytes = 4096): Promise<string> {
	try {
		return await invoke<string>('code_bg_tail', { id: processId, bytes });
	} catch {
		return '';
	}
}

/**
 * Build the user-facing body for a background-watch completion turn: one block
 * per finished command with its exit code, when it ran, and its output tail.
 * Shared by the Shell's Full access and the Code tab.
 */
/**
 * Whether a user-role message is a watch notification `buildWatchNotification`
 * wrote, not something the user typed. It is sent as a user turn so the model
 * reacts to it, but the UI shows it as a notice and keeps it out of the
 * input history. Matched on the fixed opening line, so saved threads work too.
 */
export function isWatchNotification(text: string): boolean {
	return /^(A background command you started with watch has finished\.|\d+ background commands you started with watch have finished\.)/.test(
		text
	);
}

/** The commands a watch notification reports, from its `$ command` lines. */
export function watchNotificationCommands(text: string): string[] {
	return [...text.matchAll(/^\$ (.+)$/gm)].map((m) => m[1]);
}

export async function buildWatchNotification(completed: AnyWatch[]): Promise<string> {
	const lines: string[] = [
		completed.length === 1
			? 'A background command you started with watch has finished.'
			: `${completed.length} background commands you started with watch have finished.`
	];
	for (const w of completed) {
		const tail = truncateCapturedOutput(await readWatchOutput(w), 4096);
		const finishedMs = w.completedAtMs ?? Date.now();
		lines.push(
			`\n$ ${w.command}\n` +
				`exit code: ${w.exitCode} · started ${new Date(w.startedAtMs).toLocaleTimeString()}, ` +
				`ran ${formatDuration(finishedMs - w.startedAtMs)}, finished ${describeAgo(finishedMs)}\n` +
				`--- output ---\n${tail.text || '(no output)'}\n---`
		);
	}
	lines.push(
		'\nReact as needed: report the result, fix a failure, or run the next step. ' +
			'If nothing is needed, a one-line acknowledgement is fine.'
	);
	return lines.join('\n');
}

function describeAgo(atMs: number): string {
	const s = Math.max(0, Math.round((Date.now() - atMs) / 1000));
	if (s < 5) return 'just now';
	if (s < 60) return `${s}s ago`;
	return `${Math.floor(s / 60)}m ago`;
}

/** A finished watch's output: the PTY log file, or the end of a code_bg log. */
function readWatchOutput(w: AnyWatch): Promise<string> {
	return w.source === 'pty'
		? readWatchLog(w.logPath, w.wslDistro)
		: readCodeBgLog(w.processId, 65536);
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
			if (w.source !== 'pty') continue;
			let content: string;
			try {
				content = await invoke<string>('fs_read_text_absolute', {
					path: w.donePath,
					wslDistro: w.wslDistro
				});
			} catch {
				continue; // sentinel not written yet — still running
			}
			const code = Number.parseInt(content.trim(), 10);
			if (Number.isNaN(code)) continue;
			w.exitCode = code;
			w.completedAtMs = Date.now();
			onComplete?.(w.ptySessionId);
		}
		await tickCodeBg(running.filter((w): w is CodeBgWatch => w.source === 'code_bg'));
		stopPollingIfIdle();
	} finally {
		polling = false;
	}
}

/** One `code_bg_status` call covers every running code_bg watch. */
async function tickCodeBg(running: CodeBgWatch[]): Promise<void> {
	if (running.length === 0) return;
	let procs: BgProcess[];
	try {
		procs = await invoke<BgProcess[]>('code_bg_status', { owner: null });
	} catch {
		return;
	}
	const byId = new Map(procs.map((p) => [p.id, p]));
	const gone = new Set<string>();
	const finishedOwners = new Set<string>();
	for (const w of running) {
		const p = byId.get(w.processId);
		if (!p) {
			// Stopped (command_stop, or its session closed): nothing to report.
			gone.add(w.id);
			continue;
		}
		if (p.running) continue;
		w.exitCode = p.exit_code ?? -1;
		w.completedAtMs = Date.now();
		finishedOwners.add(w.owner);
	}
	if (gone.size) watches = watches.filter((w) => !gone.has(w.id));
	for (const owner of finishedOwners) codeHandlers.get(owner)?.();
}

/** Test-only: reset module state between cases. */
export function _resetForTests(): void {
	if (pollTimer !== null) clearInterval(pollTimer);
	pollTimer = null;
	watches = [];
	polling = false;
	counter = 0;
	onComplete = null;
	codeHandlers.clear();
}
