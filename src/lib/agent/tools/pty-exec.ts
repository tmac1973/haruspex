/**
 * PTY-driven command execution for the Shell-assistant Code mode. When the
 * coding agent's `run_command` runs inside a Shell session, it injects the
 * command into the live interactive terminal (so it shares the user's venv /
 * env / cwd and shows up in their scrollback) and captures the result via the
 * existing shell-integration markers. Falls back to a one-shot capture when
 * integration isn't available (see `shouldUsePty`).
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '$lib/stores/settings';
import { truncateCapturedOutput } from '$lib/shell/truncate';
import { toBracketedPaste } from '$lib/shell/commandBlock';
import { setPtyBusy } from '$lib/stores/shellPtyBusy.svelte';
import type { ToolContext } from './types';

/** Inline output budget before middle-truncation + temp-file spill. */
export const RUN_OUTPUT_MAX_BYTES = 16 * 1024;

const PTY_POLL_MS = 100;

interface ShellCtxSnapshot {
	completed_total: number;
	current_cwd: string | null;
}
interface CapturedRegion {
	commandLine: string;
	output: string;
	exitCode: number | null;
	cwd: string | null;
	truncated: boolean;
	pending?: boolean;
}

/** The command currently running in the PTY (last marker is a start with no
 *  end), or null if the terminal is idle at a prompt. */
async function pendingCommand(sessionId: number): Promise<CapturedRegion | null> {
	try {
		const regions = await invoke<CapturedRegion[]>('shell_get_recent_commands', {
			sessionId,
			limit: 1
		});
		const last = regions[regions.length - 1];
		return last?.pending ? last : null;
	} catch {
		return null;
	}
}

/** Whether to drive the live PTY for this run vs. a one-shot capture. */
export async function shouldUsePty(ctx: ToolContext): Promise<boolean> {
	if (!ctx.shellMode || ctx.shellSessionId == null) return false;
	const mode = getSettings().codeCommandExec;
	if (mode === 'oneshot') return false;
	if (mode === 'pty') return true;
	// auto: only when the platform's shell integration is supported.
	try {
		return await invoke<boolean>('shell_platform_supported');
	} catch {
		return false;
	}
}

/**
 * Run a command in the live interactive PTY: inject it (bracketed paste +
 * Enter), lock the terminal, poll the shell-integration completion counter
 * until it ticks or the timeout fires, then return the captured region. On
 * abort, send Ctrl-C; on timeout, leave the command running (it's foreground in
 * the user's terminal) and report the output so far.
 */
export async function runInPty(
	sessionId: number,
	command: string,
	timeoutSecs: number,
	signal: AbortSignal | undefined
): Promise<string> {
	setPtyBusy(sessionId, command);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		setPtyBusy(sessionId, null);
	};
	const onAbort = () => {
		void invoke('shell_write', { sessionId, data: '\x03' }).catch(() => {});
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		// Guard: if a command is already running in this PTY — a GUI/server the
		// user launched, or a prior command that timed out and was left running —
		// it owns the terminal's stdin. Injecting now would send our keystrokes
		// to *that* program, not the shell. Refuse with a clear message instead.
		const inflight = await pendingCommand(sessionId);
		if (inflight) {
			return (
				`The terminal is busy running \`${inflight.commandLine || 'a command'}\` (still in progress), ` +
				'so a new command cannot run here yet. Use shell_read to see its output, shell_input to send ' +
				'it input (answer a prompt, or drive a REPL/debugger), or shell_interrupt to stop it and free ' +
				'the terminal. Do not re-run it.'
			);
		}

		const before = (await invoke<ShellCtxSnapshot>('shell_get_context', { sessionId }))
			.completed_total;
		await invoke('shell_write', { sessionId, data: toBracketedPaste(command, true) });

		// Poll for completion — check first, then sleep, so a fast command isn't
		// held for a full interval after it already finished.
		const deadline = Date.now() + timeoutSecs * 1000;
		let completed = false;
		while (!signal?.aborted) {
			const now = (await invoke<ShellCtxSnapshot>('shell_get_context', { sessionId }))
				.completed_total;
			if (now > before) {
				completed = true;
				break;
			}
			if (Date.now() >= deadline) break;
			await new Promise((r) => setTimeout(r, PTY_POLL_MS));
		}

		// Release the terminal the instant the command is done (or timed out /
		// aborted) — capturing + formatting the output below doesn't need the
		// lock, so the user gets the prompt back without waiting on the IPC.
		release();

		const regions = await invoke<CapturedRegion[]>('shell_get_recent_commands', {
			sessionId,
			limit: 1
		});
		const region = regions[regions.length - 1] ?? null;
		return await formatPtyResult(region, {
			completed,
			aborted: !!signal?.aborted,
			timeoutSecs
		});
	} finally {
		signal?.removeEventListener('abort', onAbort);
		release();
	}
}

export interface BackgroundHandle {
	pid: string;
	logPath: string;
	donePath: string;
}

const BG_MARKER = /HSP_BG pid=(\S+) log=(\S+) done=(\S+)/;

/**
 * Start a command in the background in the live PTY and return immediately
 * (used by run_command's `background` / `watch` options). The command runs
 * detached with stdout+stderr redirected to a temp log file, and its exit code
 * written to a sibling `.done` file when it finishes — so a watcher can detect
 * completion without holding the terminal or blocking inference.
 *
 * Returns the pid + file paths, or a human-readable error string (terminal
 * busy, or the confirmation marker couldn't be parsed). POSIX shell only.
 */
export async function runInPtyBackground(
	sessionId: number,
	command: string,
	signal: AbortSignal | undefined
): Promise<BackgroundHandle | string> {
	const inflight = await pendingCommand(sessionId);
	if (inflight) {
		return (
			`The terminal is busy running \`${inflight.commandLine || 'a command'}\`, so a background ` +
			'command cannot start here yet. Free the terminal first (shell_interrupt), then retry.'
		);
	}
	// Wrap the command so it runs detached: a temp log captures its output, a
	// sibling .done file gets the exit code on completion, and a single marker
	// line (captured as this foreground command's output) hands the pid + paths
	// back. The foreground returns to the prompt instantly, so nothing blocks.
	const wrapper =
		'__hspl="$(mktemp "${TMPDIR:-/tmp}/hsp-bg-XXXXXX")"; __hspd="${__hspl}.done"; ' +
		`{ ${command} ; printf %s "$?" > "$__hspd" ; } > "$__hspl" 2>&1 & ` +
		`printf 'HSP_BG pid=%s log=%s done=%s\\n' "$!" "$__hspl" "$__hspd"`;
	const out = await runInPty(sessionId, wrapper, 10, signal);
	const m = out.match(BG_MARKER);
	if (!m) {
		return `Tried to background the command but couldn't confirm it started. Terminal said:\n${out}`;
	}
	return { pid: m[1], logPath: m[2], donePath: m[3] };
}

async function formatPtyResult(
	region: CapturedRegion | null,
	state: { completed: boolean; aborted: boolean; timeoutSecs: number }
): Promise<string> {
	if (!region) {
		return state.aborted
			? 'Command interrupted (Ctrl-C); no output captured.'
			: 'Ran the command, but could not capture its output from the terminal.';
	}
	let header: string;
	if (state.aborted) {
		header = 'Command interrupted (Ctrl-C). Output so far:';
	} else if (region.exitCode !== null && state.completed) {
		header = `Exit code: ${region.exitCode}${region.cwd ? ` (cwd ${region.cwd})` : ''}`;
	} else {
		header =
			`Command still running after ${state.timeoutSecs}s — it's holding the terminal (a server, GUI, or ` +
			`an interactive program like a REPL or debugger). Use shell_read to watch its output, shell_input ` +
			`to send it input, or shell_interrupt to stop it. Output so far:`;
	}
	const body = region.output.replace(/\s+$/, '');
	if (!body) {
		// Be explicit so the model doesn't read "no output" as "it failed" and
		// re-run — many programs (GUIs, servers, formatters) print nothing.
		if (state.completed && region.exitCode === 0) {
			return `${header} — command succeeded with no output.`;
		}
		return `${header} (no output).`;
	}
	return spillIfLarge(header, body);
}

/**
 * Format command/terminal output under the inline budget: return it inline if
 * it fits, otherwise middle-truncate and spill the full text to a temp file the
 * model can read with fs_read_text. `body` must be non-empty. Shared by the
 * PTY runner and the interactive shell tools.
 */
export async function spillIfLarge(header: string, body: string): Promise<string> {
	const truncated = truncateCapturedOutput(body, RUN_OUTPUT_MAX_BYTES);
	if (!truncated.truncated) return `${header}\n${truncated.text}`;
	let overflowNote = '';
	try {
		const path = await invoke<string>('code_write_overflow', { content: body });
		overflowNote = `\nFull output (${truncated.originalBytes} bytes) saved to ${path} — read it with fs_read_text (offset/limit).`;
	} catch {
		// Temp-file write failed; the in-band truncation marker still stands.
	}
	return `${header}\n${truncated.text}${overflowNote}`;
}
