/**
 * What a `run_command` step's card shows, read back from the tool result the
 * model saw (`agent/tools/code.ts` `formatRunResult`): the header line carries
 * the exit code and duration, and the output follows it.
 */

export interface CommandView {
	exitCode: number | null;
	durationMs: number | null;
	/** Timed out or cancelled. */
	killed: boolean;
	/** Started detached (`background` / `watch`). */
	background: boolean;
	/** The tool refused or failed before running anything. */
	error: string | null;
	/** stdout then `[stderr]`, ANSI codes removed. */
	output: string;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** `text` without terminal colour and cursor codes. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, '');
}

export function parseCommandResult(result: string | undefined): CommandView {
	const view: CommandView = {
		exitCode: null,
		durationMs: null,
		killed: false,
		background: false,
		error: null,
		output: ''
	};
	if (!result) return view;
	const trimmed = result.trimStart();
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed) as { error?: unknown };
			if (typeof parsed.error === 'string') {
				view.error = parsed.error;
				return view;
			}
		} catch {
			// Not an error envelope; show it as output.
		}
	}
	if (trimmed.startsWith('Started in the background')) {
		view.background = true;
		view.output = trimmed;
		return view;
	}
	const nl = result.indexOf('\n');
	const header = nl < 0 ? result : result.slice(0, nl);
	const body = nl < 0 ? '' : result.slice(nl + 1);
	const exit = /^Exit code: (-?\d+|none|unknown) \((\d+)ms\)/.exec(header);
	const killed = /^Command killed .* after (\d+)ms/.exec(header);
	if (exit) {
		view.exitCode = /^-?\d+$/.test(exit[1]) ? Number(exit[1]) : null;
		view.durationMs = Number(exit[2]);
	} else if (killed) {
		view.killed = true;
		view.durationMs = Number(killed[1]);
	} else {
		view.output = stripAnsi(result);
		return view;
	}
	view.output = stripAnsi(body);
	return view;
}

/**
 * The last `maxLines` of `text`, and how many lines came before them. Command
 * output ends with what matters (the error, the summary), so the tail stays.
 */
export function tailLines(text: string, maxLines: number): { shown: string; hidden: number } {
	const lines = text.replace(/\n+$/, '').split('\n');
	if (lines.length <= maxLines) return { shown: lines.join('\n'), hidden: 0 };
	return { shown: lines.slice(-maxLines).join('\n'), hidden: lines.length - maxLines };
}

/** "850 ms", "12.4 s", "3 min 5 s". */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)} min ${s % 60} s`;
}
