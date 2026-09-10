/**
 * PTY-driven command execution for the Shell-assistant Code mode. When the
 * coding agent's `run_command` runs inside a Shell session, it injects the
 * command into the live interactive terminal (so it shares the user's venv /
 * env / cwd and shows up in their scrollback) and captures the result via the
 * existing shell-integration markers. Falls back to a one-shot capture when
 * integration isn't available (see `shouldUsePty`).
 */

import { invoke } from '@tauri-apps/api/core';
import { sleep } from '$lib/utils/async';
import { getSettings } from '$lib/stores/settings';
import { truncateCapturedOutput } from '$lib/shell/truncate';
import { toPtyPaste } from '$lib/shell/commandBlock';
import { classifyNestedSession, describeNestedSession } from '$lib/shell/nestedSession';
import {
	classifyNestedShell,
	unhookableShellMessage,
	type NestedShell
} from '$lib/shell/nestedShell';
import { setPtyBusy } from '$lib/stores/shellPtyBusy.svelte';
import type { ToolContext } from './types';

/** Inline output budget before middle-truncation + temp-file spill. */
export const RUN_OUTPUT_MAX_BYTES = 16 * 1024;

const PTY_POLL_MS = 100;

/**
 * How long to wait for a nested shell to prove it picked up the hook we
 * sourced into it. It only has to draw one prompt, which is immediate; the
 * budget is for a shell busy running a slow `~/.bashrc`.
 */
const HOOK_WAIT_MS = 3000;

interface ShellCtxSnapshot {
	completed_total: number;
	marker_total: number;
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
async function pendingCommand(sessionId: number): Promise<string | null> {
	try {
		// The dedicated command returns just the command line. Asking
		// `shell_get_recent_commands` would serialize the in-flight command's
		// entire output — for a long-running `ssh` session, the whole remote
		// transcript — only to read one field off it.
		return await invoke<string | null>('shell_pending_command', { sessionId });
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
 * Nested shells we tried and failed to hook, per session, keyed by the command
 * line that opened them. A hook that didn't take won't take on a retry either,
 * and each attempt costs the user a line of noise in their terminal.
 *
 * Only failures are recorded. A hook that worked needs no memo: the first
 * command run through it completes the outer shell's marker pair, so the
 * terminal reads as idle from then on and this path isn't reached again — and
 * if the user leaves that shell and opens another, that one does need its own
 * attempt.
 */
const failedHooks = new Map<number, Set<string>>();

/** Test seam: forget every recorded failure. */
export function resetNestedShellHooks(): void {
	failedHooks.clear();
}

function recordHookFailure(sessionId: number, command: string): void {
	const failed = failedHooks.get(sessionId);
	if (failed) failed.add(command);
	else failedHooks.set(sessionId, new Set([command]));
}

/** Single-quote for a POSIX shell: wrap, and close/escape/reopen any quote. */
function shellQuote(path: string): string {
	return `'${path.replace(/'/g, `'\\''`)}'`;
}

async function markerTotal(sessionId: number): Promise<number> {
	const ctx = await invoke<ShellCtxSnapshot>('shell_get_context', { sessionId });
	return ctx.marker_total;
}

/**
 * Turn command capture back on inside a shell the user started by hand, by
 * sourcing the same OSC 133 hook the spawn path would have installed.
 *
 * Verified rather than assumed: the hook announces itself by drawing the next
 * prompt through it, which emits markers. If the count doesn't move — no hook
 * shipped for this shell, an unreadable path, a shell that isn't what its name
 * says — we report failure and the caller falls back to a message, rather than
 * injecting a command nothing will ever mark complete.
 */
async function hookNestedShell(sessionId: number, shell: NestedShell): Promise<boolean> {
	if (failedHooks.get(sessionId)?.has(shell.command)) return false;
	if (await sourceHook(sessionId, shell)) return true;
	recordHookFailure(sessionId, shell.command);
	return false;
}

async function sourceHook(sessionId: number, shell: NestedShell): Promise<boolean> {
	let hook: string | null = null;
	try {
		hook = await invoke<string | null>('shell_integration_hook', { shell: shell.program });
	} catch {
		return false;
	}
	if (!hook) return false;

	const before = await markerTotal(sessionId);
	await invoke('shell_write', {
		sessionId,
		data: toPtyPaste(`. ${shellQuote(hook)}`, { execute: true })
	});
	const deadline = Date.now() + HOOK_WAIT_MS;
	while (Date.now() < deadline) {
		await sleep(PTY_POLL_MS);
		if ((await markerTotal(sessionId)) > before) return true;
	}
	return false;
}

/**
 * What to tell the model when the terminal already has a foreground program.
 * A nested session (ssh, a container) needs different advice from a stuck
 * build: the terminal isn't merely busy, it is somewhere else, and the way to
 * run something there is shell_input rather than waiting for it to finish.
 */
function busyMessage(inflight: string): string {
	const nested = classifyNestedSession(inflight);
	if (nested) {
		const there = nested.kind === 'remote' ? 'that host' : 'that container';
		return (
			`The terminal is inside ${describeNestedSession(nested)}, so run_command cannot start a ` +
			`command here — that session owns the terminal. To run something ON ${there}, type it with ` +
			`shell_input and read the result with shell_read. Note that ${there} is NOT this machine: ` +
			'the file tools (fs_read_text, fs_write_text, fs_edit_text, code_grep) stay local, so use the ' +
			`session for any file work on ${there}. To get back to this machine, shell_input \`exit\`.`
		);
	}
	const shell = classifyNestedShell(inflight);
	if (shell) return unhookableShellMessage(shell);
	return (
		`The terminal is busy running \`${inflight || 'a command'}\` (still in progress), ` +
		'so a new command cannot run here yet. Use shell_read to see its output, shell_input to send ' +
		'it input (answer a prompt, or drive a REPL/debugger), or shell_interrupt to stop it and free ' +
		'the terminal. Do not re-run it.'
	);
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
		let inflight = await pendingCommand(sessionId);
		if (inflight) {
			// A shell the user opened by hand (`bash` at a fish prompt) reads as
			// a command that never ends, because the outer shell's "finished"
			// marker only fires when it exits. It is really sitting at a prompt
			// ready for input — so install the hook it's missing and carry on,
			// rather than refusing for as long as the user stays in it.
			const shell = classifyNestedShell(inflight);
			if (shell?.hookable && (await hookNestedShell(sessionId, shell))) inflight = null;
		}
		if (inflight) return busyMessage(inflight);

		const before = (await invoke<ShellCtxSnapshot>('shell_get_context', { sessionId }))
			.completed_total;
		await invoke('shell_write', { sessionId, data: toPtyPaste(command, { execute: true }) });

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
			await sleep(PTY_POLL_MS);
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
	let inflight = await pendingCommand(sessionId);
	if (inflight) {
		const shell = classifyNestedShell(inflight);
		if (shell?.hookable && (await hookNestedShell(sessionId, shell))) inflight = null;
	}
	if (inflight) {
		const nested = classifyNestedSession(inflight);
		if (nested) {
			return (
				`The terminal is inside ${describeNestedSession(nested)}, so nothing can be backgrounded ` +
				'here — a background command would have to be started inside that session with shell_input ' +
				`(\`cmd > log 2>&1 &\`). Leave the session first (shell_input \`exit\`) if you meant to run it on ` +
				'this machine.'
			);
		}
		const shell = classifyNestedShell(inflight);
		if (shell) {
			return (
				`The terminal has \`${shell.command}\` open inside it — a second shell with none of the ` +
				'command-capture hooks, so nothing can be backgrounded through it. Send `exit` with ' +
				'shell_input to return to the outer shell, then retry.'
			);
		}
		return (
			`The terminal is busy running \`${inflight || 'a command'}\`, so a background ` +
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
