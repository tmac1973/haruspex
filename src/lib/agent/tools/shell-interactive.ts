/**
 * Interactive PTY-control tools for Shell-tab Code mode.
 *
 * `run_command` runs a command to completion, but that model breaks on the
 * single live terminal for two cases: a process that never exits (a server)
 * holds the shell, and an interactive program (gdb, a REPL, a `[y/N]` prompt)
 * blocks waiting for input that `run_command` can't supply. These three tools
 * expose the PTY's interactivity so the agent can drive and reclaim the
 * terminal:
 *
 *   - shell_read      — see what a running (or the last) program produced
 *   - shell_input     — type a line into the running program
 *   - shell_interrupt — Ctrl-C (or Ctrl-\) the foreground process
 *
 * They reuse the existing shell IPC (shell_write / shell_get_recent_commands /
 * shell_get_context) — no new backend. Only exposed in Code mode inside a live
 * shell session (see registry `SHELL_INTERACTIVE_TOOLS`).
 */

import { invoke } from '@tauri-apps/api/core';
import { labelArg, toolInvokeError } from './_helpers';
import { registerTool } from './registry';
import { toolError, toolResult } from './types';
import type { ToolContext, ToolExecOutput } from './types';
import { spillIfLarge } from './pty-exec';

interface CapturedRegion {
	commandLine: string;
	output: string;
	exitCode: number | null;
	cwd: string | null;
	truncated: boolean;
	pending?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// settle/interrupt polling cadence (ms).
const SETTLE_POLL_MS = 150;
const SETTLE_MAX_MS = 6000;
const INTERRUPT_POLL_MS = 150;
const INTERRUPT_MAX_MS = 4000;

/** The most recent terminal region — the in-flight command if one is running,
 *  else the last completed command, or null if nothing has run yet. */
async function lastRegion(sessionId: number): Promise<CapturedRegion | null> {
	const regions = await invoke<CapturedRegion[]>('shell_get_recent_commands', {
		sessionId,
		limit: 1
	});
	return regions[regions.length - 1] ?? null;
}

async function completedTotal(sessionId: number): Promise<number> {
	const ctx = await invoke<{ completed_total: number }>('shell_get_context', { sessionId });
	return ctx.completed_total;
}

/** Resolve the active shell session id, or a tool-error result explaining that
 *  these tools only work inside a live terminal. */
function sessionOrError(ctx: ToolContext, tool: string): number | { message: string } {
	if (ctx.shellSessionId == null) {
		return {
			message: toolError(
				`${tool} only works in a live terminal session — there is no interactive process to control here.`
			)
		};
	}
	return ctx.shellSessionId;
}

/** New output appended after `baseline` (what was on screen before we sent
 *  input). Falls back to the whole buffer if the output ring rotated past it. */
function sliceAfter(cur: string, baseline: string): string {
	if (baseline && cur.startsWith(baseline)) return cur.slice(baseline.length);
	return cur;
}

/** After sending input, poll the in-flight region until its output stops
 *  growing (stable across two polls), the program exits, or the max wait
 *  elapses; return whatever appeared after `baseline`. */
async function settleNewOutput(
	sessionId: number,
	baseline: string
): Promise<{ text: string; stillRunning: boolean }> {
	const deadline = Date.now() + SETTLE_MAX_MS;
	let prev = '';
	let stable = 0;
	for (;;) {
		await sleep(SETTLE_POLL_MS);
		const region = await lastRegion(sessionId);
		const cur = region?.output ?? '';
		if (!region?.pending) return { text: sliceAfter(cur, baseline), stillRunning: false };
		if (cur === prev) {
			if (++stable >= 2) return { text: sliceAfter(cur, baseline), stillRunning: true };
		} else {
			stable = 0;
		}
		prev = cur;
		if (Date.now() >= deadline) return { text: sliceAfter(cur, baseline), stillRunning: true };
	}
}

/** Wait (up to INTERRUPT_MAX_MS) for a new command-completion marker, i.e. the
 *  foreground process died and the shell re-prompted. */
async function waitForCompletion(sessionId: number, before: number): Promise<boolean> {
	const deadline = Date.now() + INTERRUPT_MAX_MS;
	for (;;) {
		await sleep(INTERRUPT_POLL_MS);
		try {
			if ((await completedTotal(sessionId)) > before) return true;
		} catch {
			return false;
		}
		if (Date.now() >= deadline) return false;
	}
}

registerTool({
	category: 'exec',
	schema: {
		type: 'function',
		function: {
			name: 'shell_read',
			description:
				"Read the current terminal output: the output so far of a program that's still running (a server's logs, an interactive program's screen), or the result of the last command. Use this to observe a long-running or interactive program without sending it any input.",
			parameters: { type: 'object', properties: {} }
		}
	},
	displayLabel: () => 'read terminal',
	async execute(_args, ctx): Promise<ToolExecOutput> {
		const sid = sessionOrError(ctx, 'shell_read');
		if (typeof sid !== 'number') return toolResult(sid.message);
		try {
			const region = await lastRegion(sid);
			if (!region) return toolResult('The terminal is idle at a prompt; nothing has run yet.');
			const body = region.output.replace(/\s+$/, '');
			const header = region.pending
				? `\`${region.commandLine || 'A command'}\` is still running. Output so far:`
				: `Last command finished (exit ${region.exitCode ?? 'unknown'}). Output:`;
			if (!body) {
				return toolResult(
					region.pending
						? `${header} (no output yet — it may be waiting for input).`
						: `${header} (no output).`
				);
			}
			return toolResult(await spillIfLarge(header, body));
		} catch (e) {
			return toolResult(toolInvokeError('shell_read', e));
		}
	}
});

registerTool({
	category: 'exec',
	schema: {
		type: 'function',
		function: {
			name: 'shell_input',
			description:
				'Send a line of input to the program currently running in the terminal — for interactive programs like gdb, a language REPL, or a command waiting at a prompt (e.g. [y/N]). The text is sent followed by Enter (set enter:false for raw keystrokes with no newline). Returns the output that follows. Only works while a program is actively running/waiting (check with shell_read); to START a command, use run_command instead.',
			parameters: {
				type: 'object',
				properties: {
					text: {
						type: 'string',
						description: 'The line to type. Empty string sends just Enter.'
					},
					enter: {
						type: 'boolean',
						description: 'Append a newline (press Enter). Defaults to true.'
					}
				}
			}
		}
	},
	displayLabel: labelArg('text'),
	async execute(args, ctx): Promise<ToolExecOutput> {
		const sid = sessionOrError(ctx, 'shell_input');
		if (typeof sid !== 'number') return toolResult(sid.message);
		const text = typeof args.text === 'string' ? args.text : '';
		const enter = args.enter !== false;
		try {
			// Require an in-flight program. At an idle shell prompt this would just
			// type a command and run it — bypassing run_command's risk-approval
			// gate — so refuse and redirect.
			const before = await lastRegion(sid);
			if (!before?.pending) {
				return toolResult(
					toolError(
						'Nothing is currently running or waiting for input in the terminal. shell_input only feeds an already-running interactive program. To run a command, use run_command (which goes through the safety check).'
					)
				);
			}
			const baseline = before.output;
			await invoke('shell_write', { sessionId: sid, data: text + (enter ? '\n' : '') });
			const { text: produced, stillRunning } = await settleNewOutput(sid, baseline);
			const what = text ? `Sent \`${text}\`` : 'Sent Enter';
			const header = `${what}. ${stillRunning ? 'Output since:' : 'The program then exited. Output:'}`;
			const body = produced.replace(/\s+$/, '');
			if (!body) return toolResult(`${header} (no new output).`);
			return toolResult(await spillIfLarge(header, body));
		} catch (e) {
			return toolResult(toolInvokeError('shell_input', e));
		}
	}
});

registerTool({
	category: 'exec',
	schema: {
		type: 'function',
		function: {
			name: 'shell_interrupt',
			description:
				'Stop the program currently running in the terminal (a server, REPL, or a hung command) by sending Ctrl-C (SIGINT). Set force:true to send a stronger Ctrl-\\ (SIGQUIT) for programs that ignore Ctrl-C. Use this to reclaim the terminal when a command you started is holding it.',
			parameters: {
				type: 'object',
				properties: {
					force: {
						type: 'boolean',
						description:
							'Send Ctrl-\\ (SIGQUIT) instead of Ctrl-C, for processes that ignore SIGINT.'
					}
				}
			}
		}
	},
	displayLabel: (args) => (args.force ? 'interrupt (force)' : 'interrupt'),
	async execute(args, ctx): Promise<ToolExecOutput> {
		const sid = sessionOrError(ctx, 'shell_interrupt');
		if (typeof sid !== 'number') return toolResult(sid.message);
		const force = args.force === true;
		try {
			const running = await lastRegion(sid);
			const wasRunning = !!running?.pending;
			const before = await completedTotal(sid);
			await invoke('shell_write', { sessionId: sid, data: force ? '\x1c' : '\x03' });
			const label = force ? 'Ctrl-\\ (SIGQUIT)' : 'Ctrl-C (SIGINT)';
			if (!wasRunning) {
				return toolResult(
					`Sent ${label}, but nothing was running — the terminal was already idle at a prompt.`
				);
			}
			const stopped = await waitForCompletion(sid, before);
			if (stopped) {
				const region = await lastRegion(sid);
				const body = (region?.output ?? '').replace(/\s+$/, '');
				const header = `Sent ${label}; the program stopped and the terminal is free again.`;
				return toolResult(body ? await spillIfLarge(`${header} Final output:`, body) : header);
			}
			return toolResult(
				`Sent ${label}, but the program is still running after ${INTERRUPT_MAX_MS / 1000}s — it may be ignoring the signal.` +
					(force
						? ' If it stays stuck, ask the user to use the terminal Restart button.'
						: ' Try shell_interrupt again with force:true.')
			);
		} catch (e) {
			return toolResult(toolInvokeError('shell_interrupt', e));
		}
	}
});
