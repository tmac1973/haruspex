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
				'so a new command cannot run here yet. Do not try to kill or re-run it — wait for it to ' +
				'finish or for the user to exit it, then continue. If you just launched something the user ' +
				'is meant to interact with, tell them it is running and stop here.'
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
			`Command still running in your terminal after ${state.timeoutSecs}s — it's holding the terminal ` +
			`(a GUI, server, or interactive prompt). You cannot run more commands here until it exits. Do not ` +
			`try to kill or re-run it — tell the user it's running and let them exit it when done. Output so far:`;
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
	const truncated = truncateCapturedOutput(body, RUN_OUTPUT_MAX_BYTES);
	if (!truncated.truncated) return `${header}\n${truncated.text}`;
	let overflowNote = '';
	try {
		const path = await invoke<string>('code_write_overflow', { content: body });
		overflowNote = `\nFull output (${truncated.originalBytes} bytes) saved to ${path} — read it with fs_read_text.`;
	} catch {
		// Temp-file write failed; the in-band truncation marker still stands.
	}
	return `${header}\n${truncated.text}${overflowNote}`;
}
