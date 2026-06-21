import { invoke } from '@tauri-apps/api/core';
import { labelArg, toolInvokeError } from './_helpers';
import { registerTool } from './registry';
import { toolError, toolResult } from './types';
import type { ToolContext, ToolExecOutput } from './types';
import { getSettings } from '$lib/stores/settings';
import { classifyShellRisk } from '$lib/shell/risky-commands';
import { truncateCapturedOutput } from '$lib/shell/truncate';
import {
	askCommandApproval,
	isSessionApproved,
	approveSession
} from '$lib/stores/codeCommandApproval.svelte';
import { runInPty, shouldUsePty, RUN_OUTPUT_MAX_BYTES } from './pty-exec';
import type { RunCommandResult } from '$lib/ipc/gen/RunCommandResult';
import type { GrepResult } from '$lib/ipc/gen/GrepResult';
import type { GlobResult } from '$lib/ipc/gen/GlobResult';

/**
 * The directory the code tools operate in: the live shell CWD when driven from
 * a Shell session (Code mode), otherwise the Code tab's working directory.
 */
function codeRoot(ctx: ToolContext): string | null {
	return ctx.shellMode ? (ctx.shellCwd ?? null) : ctx.workingDir;
}

/**
 * Run the risk-classifier approval gate. Returns `'ok'` to proceed, or a
 * `{ message }` tool result to return instead (denied, or the approval prompt
 * errored). Auto-approve and per-session approval short-circuit the prompt.
 */
async function ensureCommandApproved(
	command: string,
	ctx: ToolContext
): Promise<'ok' | { message: string }> {
	if (ctx.codeAutoApprove || isSessionApproved()) return 'ok';
	const risk = classifyShellRisk(command);
	if (!risk.matched) return 'ok';
	let choice;
	try {
		choice = await askCommandApproval({ command, reasons: risk.reasons });
	} catch (e) {
		return { message: toolInvokeError('run_command approval', e) };
	}
	if (choice === 'deny') {
		return {
			message:
				'Command denied by the user. Do not retry it — ask how they would like to proceed or take a different approach.'
		};
	}
	if (choice === 'allow_session') approveSession();
	return 'ok';
}

/**
 * Run `run_command_capture`, wiring `ctx.signal` to `run_command_cancel` so a
 * mid-command cancel actually kills the host process tree (the agent loop
 * races the tool against the abort, but that only discards our result — the
 * Rust process would keep running without this).
 */
async function runHostCommand(
	command: string,
	cwd: string,
	timeoutSecs: number,
	signal: AbortSignal | undefined
): Promise<RunCommandResult> {
	const commandId = crypto.randomUUID();
	if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
	const onAbort = () => {
		void invoke('run_command_cancel', { commandId }).catch(() => {});
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		return await invoke<RunCommandResult>('run_command_capture', {
			command,
			cwd,
			timeoutSecs,
			commandId
		});
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}

/** Format a command result, leading with the exit code (highest signal). */
async function formatRunResult(res: RunCommandResult): Promise<string> {
	const header = res.killed
		? `Command killed (timeout or cancellation) after ${res.duration_ms}ms.`
		: `Exit code: ${res.exit_code ?? 'unknown'} (${res.duration_ms}ms)`;

	// Combine streams, labeling stderr so the model can tell them apart.
	const parts: string[] = [];
	if (res.stdout.trim()) parts.push(res.stdout.replace(/\s+$/, ''));
	if (res.stderr.trim()) parts.push(`[stderr]\n${res.stderr.replace(/\s+$/, '')}`);
	const combined = parts.join('\n');
	if (!combined) {
		// Explicit so the model doesn't read "no output" as failure and re-run.
		if (!res.killed && res.exit_code === 0) return `${header} — command succeeded with no output.`;
		return `${header} (no output).`;
	}

	const truncated = truncateCapturedOutput(combined, RUN_OUTPUT_MAX_BYTES);
	if (!truncated.truncated) {
		return `${header}\n${truncated.text}`;
	}
	// Spill the full output so the model can read the dropped region on demand.
	let overflowNote = '';
	try {
		const path = await invoke<string>('code_write_overflow', { content: combined });
		overflowNote = `\nFull output (${truncated.originalBytes} bytes) saved to ${path} — read it with fs_read_text (offset/limit).`;
	} catch {
		// Temp-file write failed; the in-band truncation marker still stands.
	}
	return `${header}\n${truncated.text}${overflowNote}`;
}

registerTool({
	category: 'exec',
	schema: {
		type: 'function',
		function: {
			name: 'run_command',
			description:
				"Run a shell command in the project. When driven from a terminal session it runs in your live interactive shell (sharing the activated venv / env / cwd) and appears in your terminal; otherwise it runs one-shot. cwd/env changes from a one-shot don't persist between calls, so chain with && when needed. Output is truncated past ~16KB; if so, the full output is saved to a file path you can read with fs_read_text.",
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'The shell command to run.' },
					timeout_secs: {
						type: 'number',
						description: 'Optional timeout in seconds for this command.'
					}
				},
				required: ['command']
			}
		}
	},
	displayLabel: labelArg('command'),
	async execute(args, ctx): Promise<ToolExecOutput> {
		const command = (args.command as string)?.trim();
		if (!command) return toolResult(toolError('run_command requires a non-empty command.'));
		const root = codeRoot(ctx);
		if (!root) return toolResult(toolError('No working directory set.'));

		const approval = await ensureCommandApproved(command, ctx);
		if (approval !== 'ok') return toolResult(approval.message);

		const fallbackTimeout = getSettings().codeRunCommandTimeoutSecs;
		const timeoutSecs =
			typeof args.timeout_secs === 'number' && args.timeout_secs > 0
				? Math.floor(args.timeout_secs)
				: fallbackTimeout;

		try {
			// Drive the live PTY when in a shell session and integration is
			// available; otherwise fall back to a one-shot capture.
			if (ctx.shellSessionId != null && (await shouldUsePty(ctx))) {
				return toolResult(await runInPty(ctx.shellSessionId, command, timeoutSecs, ctx.signal));
			}
			const res = await runHostCommand(command, root, timeoutSecs, ctx.signal);
			return toolResult(await formatRunResult(res));
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') throw e;
			return toolResult(toolInvokeError('run_command', e));
		}
	}
});

function formatGrep(res: GrepResult): string {
	if (res.matches.length === 0) return 'No matches.';
	const lines = res.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
	if (res.truncated) {
		lines.push(`… (truncated at ${res.matches.length} matches — narrow the pattern or path)`);
	}
	return lines.join('\n');
}

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'code_grep',
			description:
				'Search file CONTENTS across the project (gitignore-aware). Returns file:line: matched-line locations, not file bodies. Find where something is defined or used, then fs_read_text those lines.',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'Text or regular expression.' },
					path: { type: 'string', description: 'Optional subdirectory to limit the search.' },
					glob: { type: 'string', description: 'Optional file filter, e.g. "*.rs".' },
					ignore_case: { type: 'boolean', description: 'Case-insensitive when true.' }
				},
				required: ['pattern']
			}
		}
	},
	displayLabel: labelArg('pattern'),
	async execute(args, ctx): Promise<ToolExecOutput> {
		const root = codeRoot(ctx);
		if (!root) return toolResult(toolError('No working directory set.'));
		try {
			const res = await invoke<GrepResult>('code_grep', {
				root,
				pattern: args.pattern as string,
				path: (args.path as string) ?? null,
				glob: (args.glob as string) ?? null,
				ignoreCase: (args.ignore_case as boolean) ?? null,
				maxMatches: null
			});
			return toolResult(formatGrep(res));
		} catch (e) {
			return toolResult(toolInvokeError('code_grep', e));
		}
	}
});

function formatGlob(res: GlobResult): string {
	if (res.paths.length === 0) return 'No files match.';
	const lines = [...res.paths];
	if (res.truncated) {
		lines.push(`… (truncated at ${res.paths.length} files — narrow the pattern)`);
	}
	return lines.join('\n');
}

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'code_glob',
			description:
				'Find files by path glob across the project (gitignore-aware). Returns file paths only.',
			parameters: {
				type: 'object',
				properties: {
					pattern: {
						type: 'string',
						description: 'Glob, e.g. "src/**/*.ts" or "**/Cargo.toml".'
					}
				},
				required: ['pattern']
			}
		}
	},
	displayLabel: labelArg('pattern'),
	async execute(args, ctx): Promise<ToolExecOutput> {
		const root = codeRoot(ctx);
		if (!root) return toolResult(toolError('No working directory set.'));
		try {
			const res = await invoke<GlobResult>('code_glob', {
				root,
				pattern: args.pattern as string,
				maxResults: null
			});
			return toolResult(formatGlob(res));
		} catch (e) {
			return toolResult(toolInvokeError('code_glob', e));
		}
	}
});
