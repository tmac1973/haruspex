/**
 * The Code tab's background commands: `run_command` with background/watch
 * starts one here as a Rust-side process (`code_bg_*`) owned by the Code
 * session, and `command_output` / `command_stop` read and stop it. Offered
 * only to the Code tab (`codeMode && !shellMode`); the Shell's Code mode
 * backgrounds commands in its live terminal instead (`./code`).
 */
import { invoke } from '@tauri-apps/api/core';
import { labelArg, toolInvokeError } from './_helpers';
import { registerTool } from './registry';
import { toolError, toolResult } from './types';
import type { ToolContext, ToolExecOutput } from './types';
import { registerCodeBgWatch } from '#lib/shell/backgroundWatch.ts';
import { commandMemoryLimitPercent } from '#lib/shell/memoryLimit.ts';
import { getSettings } from '#lib/stores/settings.ts';
import type { BgStarted } from '#lib/ipc/gen/BgStarted.ts';
import type { BgProcess } from '#lib/ipc/gen/BgProcess.ts';

/** No terminal: run it as a `code_bg` process owned by the Code session. */
export async function startCodeBackground(
	command: string,
	cwd: string,
	wslDistro: string | null,
	owner: string,
	watch: boolean
): Promise<string> {
	const started = await invoke<BgStarted>('code_bg_start', {
		owner,
		cwd,
		wslDistro,
		command,
		memoryLimitPercent: commandMemoryLimitPercent(),
		logCapMb: getSettings().codeBgLogCapMb
	});
	if (watch) {
		registerCodeBgWatch({
			owner,
			processId: started.id,
			command,
			logPath: started.log_path,
			startedAtMs: Date.now()
		});
		return (
			`Started in the background with watch on (id ${started.id}, PID ${started.pid}). ` +
			`You'll get a notification turn here when it finishes — do NOT poll for it; continue with other work or wrap up. ` +
			`Read its output so far with command_output; stop it with command_stop.`
		);
	}
	return (
		`Started in the background (id ${started.id}, PID ${started.pid}). ` +
		`Read its output with command_output and stop it with command_stop, passing the id.`
	);
}

/**
 * Find one of this Code session's background processes, or a tool error
 * message. A session only sees its own.
 */
async function findOwnProcess(
	id: unknown,
	ctx: ToolContext,
	tool: string
): Promise<BgProcess | string> {
	if (typeof id !== 'string' || !id.trim()) return toolError(`${tool} requires an id.`);
	if (!ctx.codeSessionId) {
		return toolError(`${tool} only works for background commands started in a Code session.`);
	}
	const procs = await invoke<BgProcess[]>('code_bg_status', { owner: ctx.codeSessionId });
	return (
		procs.find((p) => p.id === id.trim()) ??
		toolError(`No background command with id ${id} in this session. It may have been stopped.`)
	);
}

/** "Running for 12s (PID 4242)" / "Exited with code 1" / "Killed by a signal". */
export function describeBgProcess(p: BgProcess, nowMs = Date.now()): string {
	if (p.running) {
		const secs = Math.max(0, Math.round((nowMs - p.started_at) / 1000));
		return `Running for ${secs}s (PID ${p.pid}): ${p.command}`;
	}
	return p.exit_code == null
		? `Finished, killed by a signal: ${p.command}`
		: `Finished with exit code ${p.exit_code}: ${p.command}`;
}

const OUTPUT_DEFAULT_BYTES = 8192;
const OUTPUT_MAX_BYTES = 65536;

registerTool({
	category: 'exec',
	schema: {
		type: 'function',
		function: {
			name: 'command_output',
			description:
				'Read the latest output of a background command you started with run_command (background or watch), and whether it is still running.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'The id run_command returned.' },
					bytes: {
						type: 'number',
						description: `How much of the end of the output to return (default ${OUTPUT_DEFAULT_BYTES}).`
					}
				},
				required: ['id']
			}
		}
	},
	displayLabel: labelArg('id'),
	async execute(args, ctx): Promise<ToolExecOutput> {
		try {
			const proc = await findOwnProcess(args.id, ctx, 'command_output');
			if (typeof proc === 'string') return toolResult(proc);
			const bytes =
				typeof args.bytes === 'number' && args.bytes > 0
					? Math.min(Math.floor(args.bytes), OUTPUT_MAX_BYTES)
					: OUTPUT_DEFAULT_BYTES;
			const tail = await invoke<string>('code_bg_tail', { id: proc.id, bytes });
			const status = describeBgProcess(proc);
			return toolResult(
				tail.trim()
					? `${status}\n\nLast output:\n${tail.replace(/\s+$/, '')}`
					: `${status}\n\n(no output yet)`
			);
		} catch (e) {
			return toolResult(toolInvokeError('command_output', e));
		}
	}
});

registerTool({
	category: 'exec',
	schema: {
		type: 'function',
		function: {
			name: 'command_stop',
			description:
				'Stop a background command you started with run_command, and everything it started. Its output is discarded.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'The id run_command returned.' }
				},
				required: ['id']
			}
		}
	},
	displayLabel: labelArg('id'),
	async execute(args, ctx): Promise<ToolExecOutput> {
		try {
			const proc = await findOwnProcess(args.id, ctx, 'command_stop');
			if (typeof proc === 'string') return toolResult(proc);
			await invoke('code_bg_stop', { id: proc.id });
			return toolResult(`Stopped ${proc.id}: ${proc.command}`);
		} catch (e) {
			return toolResult(toolInvokeError('command_stop', e));
		}
	}
});
