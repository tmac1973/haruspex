/**
 * The Code tab's hand-offs to the user: `open_in_shell` puts a command in a
 * new Shell tab for the user to run (sudo, password prompts, anything that
 * wants a terminal) and waits for the result; `open_in_editor` shows files in
 * an editor window and returns at once. Offered only to the Code tab
 * (`codeTabProfile.ts`).
 */
import { labelArg } from './_helpers';
import { registerTool } from './registry';
import { toolError, toolResult } from './types';
import type { ToolContext, ToolExecOutput } from './types';
import { checkCommandBoundary } from './code';
import { spillIfLarge } from './pty-exec';
import {
	openShellForCommand,
	reportShellWait,
	type ShellCommandResult
} from '#lib/code/shellBridge.ts';
import { loadShellPlatformSupported } from '#lib/shell/platformSupport.ts';
import { relativeToRoot } from '#lib/code/paths.ts';
import { openInEditor } from '#lib/code/openEditor.ts';

/** The model-facing text for what came back from the shell. */
export async function describeShellResult(
	res: ShellCommandResult,
	typed: string,
	cancelled: boolean
): Promise<string> {
	switch (res.kind) {
		case 'unavailable':
			return toolError(`Couldn't open a Shell tab: ${res.message}`);
		case 'opened':
			return (
				`Opened in ${res.shellName} with the command typed in. That shell doesn't report when a ` +
				'command finishes, so ask the user for the result.'
			);
		case 'closed':
			return (
				`${res.shellName} was closed before the command finished, so there is no result. ` +
				'Ask the user whether it ran.'
			);
		case 'aborted':
			return cancelled
				? `The user stopped waiting for ${res.shellName}. The command may still run there; ask the user for the result if you need it.`
				: `Stopped waiting for ${res.shellName}.`;
		case 'completed': {
			const header =
				`Exit code: ${res.exitCode ?? 'unknown'} (${res.durationMs}ms), run by the user in ${res.shellName}` +
				(res.cwd ? ` (cwd ${res.cwd})` : '');
			const edited =
				res.command.trim() !== typed.trim()
					? `\n\nThe user changed the command before running it. What ran: ${res.command}`
					: '';
			const body = res.output.replace(/\s+$/, '');
			if (!body) {
				const none = res.exitCode === 0 ? ' — command succeeded with no output.' : ' (no output).';
				return `${header}${none}${edited}`;
			}
			return `${await spillIfLarge(header, body)}${edited}`;
		}
	}
}

registerTool({
	category: 'exec',
	schema: {
		type: 'function',
		function: {
			name: 'open_in_shell',
			description:
				'Hand a command to the user in a new Shell tab: it opens at the project folder with the command typed in but NOT run, and waits while the user reads it and presses Enter. Use it for anything run_command cannot do: sudo or another password prompt, an interactive installer, a login. Returns the exit code and output, and the command that actually ran if the user changed it. Do not use it for commands run_command can run.',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'The command to type in the shell.' },
					reason: {
						type: 'string',
						description: 'Why the user needs to run it, in a few words.'
					}
				},
				required: ['command']
			}
		}
	},
	displayLabel: labelArg('command'),
	async execute(args, ctx): Promise<ToolExecOutput> {
		const command = typeof args.command === 'string' ? args.command.trim() : '';
		if (!command) return toolResult(toolError('open_in_shell requires a non-empty command.'));
		const root = ctx.workingDir;
		if (!ctx.codeSessionId || !root) {
			return toolResult(toolError('open_in_shell only works in a Code session.'));
		}
		if ((await loadShellPlatformSupported()) === false) {
			return toolResult(toolError('The Shell tab is not available on this platform.'));
		}
		// The boundary still applies. No risk prompt: the user pressing Enter
		// in the shell is the approval.
		const boundary = await checkCommandBoundary(command, ctx);
		if (boundary !== 'ok') return toolResult(boundary.message);
		return toolResult(await waitInShell(command, root, ctx, ctx.codeSessionId));
	}
});

/**
 * Open the shell and wait, showing the wait on the session. Stop (the turn's
 * signal) ends the turn; Cancel (the wait's own) only ends the wait.
 */
async function waitInShell(
	command: string,
	root: string,
	ctx: ToolContext,
	sessionId: string
): Promise<string> {
	const wait = new AbortController();
	const stop = () => wait.abort();
	if (ctx.signal?.aborted) wait.abort();
	ctx.signal?.addEventListener('abort', stop, { once: true });
	let cancelled = false;
	try {
		const res = await openShellForCommand({
			command,
			cwd: root,
			wslDistro: ctx.wslDistro ?? null,
			wait: true,
			signal: wait.signal,
			onOpened: (shell) => {
				reportShellWait(sessionId, {
					shellName: shell.name,
					command,
					focus: shell.focus,
					cancel: () => {
						cancelled = true;
						wait.abort();
					}
				});
			}
		});
		return await describeShellResult(res, command, cancelled && !ctx.signal?.aborted);
	} finally {
		ctx.signal?.removeEventListener('abort', stop);
		reportShellWait(sessionId, null);
	}
}

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'open_in_editor',
			description:
				"Open files from the project in the user's editor window (one per project folder, a tab per file) so they can look at them, and return at once. It does not wait for edits: if you need the user to change something, ask them.",
			parameters: {
				type: 'object',
				properties: {
					paths: {
						type: 'array',
						items: { type: 'string' },
						description: 'Files to open, relative to the project folder.'
					},
					reason: {
						type: 'string',
						description: 'What to look at, in a few words.'
					}
				},
				required: ['paths']
			}
		}
	},
	displayLabel: (args) =>
		Array.isArray(args.paths) ? args.paths.map(String).join(', ') : String(args.paths ?? ''),
	async execute(args, ctx): Promise<ToolExecOutput> {
		const root = ctx.workingDir;
		if (!root) return toolResult(toolError('No working directory set.'));
		const raw = Array.isArray(args.paths)
			? args.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
			: typeof args.paths === 'string'
				? [args.paths]
				: [];
		if (raw.length === 0) return toolResult(toolError('open_in_editor requires paths.'));
		const outside = raw.filter((p) => relativeToRoot(root, p) === null);
		if (outside.length > 0) {
			return toolResult(
				toolError(`Only files inside the project folder can be opened: ${outside.join(', ')}`)
			);
		}
		const files = [...new Set(raw.map((p) => relativeToRoot(root, p) as string))];
		const opened = await openInEditor(root, files, ctx.shellMode ? null : (ctx.wslDistro ?? null));
		if (!opened.ok) return toolResult(toolError(opened.error));
		return toolResult(
			`${opened.summary} The user's edits are not reported back; ask if you need them.`
		);
	}
});
