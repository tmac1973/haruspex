/**
 * Recognizing when the terminal has stepped into *another shell on this
 * machine* — `bash` typed at a fish prompt, `zsh` at a bash one.
 *
 * Sibling of `nestedSession.ts`, and deliberately separate: an ssh or a
 * container moves the filesystem out from under the file tools, while this
 * doesn't move anything. What it breaks instead is command capture.
 *
 * Haruspex installs its OSC 133 hook when it *spawns* the shell
 * (`pty::plan_integration` — `bash --rcfile`, a ZDOTDIR for zsh). A shell the
 * user starts by typing its name never went through that, so it emits no
 * markers at all. Two things go wrong at once:
 *
 *  - The outer shell emitted a "command started" marker for `bash` and won't
 *    emit the matching "ended" until it exits, so `shell_pending_command`
 *    reports the terminal as busy running `bash` indefinitely, and
 *    run_command's busy guard refuses every command.
 *  - Even past the guard, nothing would mark the injected command complete,
 *    so the run would poll until it timed out.
 *
 * For the shells we ship a hook for, both are fixable by sourcing that hook
 * into the inner shell — it is the same file the spawn path would have used.
 * For the rest (fish, nu, a plain `sh`) there is nothing to source, and the
 * honest answer is to tell the model to drive the session with shell_input.
 */

import { basename, tokenize, unwrap } from './nestedSession';

export interface NestedShell {
	/** Basename of the shell sitting at a prompt inside the terminal. */
	program: string;
	/** Whether we ship an OSC 133 hook that can be sourced into it. */
	hookable: boolean;
	/** The command line that opened it, as captured. */
	command: string;
}

/** Shells whose hook we bundle, keyed by basename. */
const HOOKABLE = new Set(['bash', 'zsh']);

/**
 * Interactive shells with no hook of ours. Listed rather than inferred so an
 * unrecognized program keeps the old "something is running" treatment: a
 * long-running build is far more common than an exotic shell, and telling the
 * model to `exit` out of a build would be worse than telling it to wait.
 */
const UNHOOKABLE = new Set([
	'sh',
	'dash',
	'ash',
	'busybox',
	'fish',
	'nu',
	'ksh',
	'mksh',
	'tcsh',
	'csh',
	'xonsh',
	'elvish',
	'pwsh',
	'powershell'
]);

/**
 * A `-c` in any form means the shell was handed a command to run, so it is a
 * one-shot that owns the terminal until it finishes — not a prompt waiting for
 * input. Matches the bundled short form too (`sh -ec '…'`).
 */
function carriesCommand(token: string): boolean {
	if (token === '-c' || token === '--command') return true;
	return /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token);
}

/**
 * Classify the terminal's in-flight command as a nested interactive shell, or
 * null when it's anything else (a build, a server, a REPL, an ssh session).
 *
 * Only a bare invocation counts: `bash`, `bash -l`, `sudo -i zsh`. Anything
 * with an operand is running a script or a command (`bash deploy.sh`,
 * `sh -c 'make'`), which genuinely holds the terminal until it's done.
 */
export function classifyNestedShell(commandLine: string | null | undefined): NestedShell | null {
	if (!commandLine) return null;
	// Unlike a nested session, a chain doesn't reduce to its last stage: `make
	// && bash` runs bash only if make succeeds, and the capture we're looking at
	// is the whole line. Anything compound is ambiguous enough to leave alone.
	if (/\|\||&&|;|\||&|>|</.test(commandLine)) return null;
	const tokens = unwrap(tokenize(commandLine));
	if (tokens.length === 0) return null;

	const program = basename(tokens[0]);
	const hookable = HOOKABLE.has(program);
	if (!hookable && !UNHOOKABLE.has(program)) return null;

	// Flags are fine (`-l`, `--norc`); an operand is not.
	for (const t of tokens.slice(1)) {
		if (!t.startsWith('-') || carriesCommand(t)) return null;
	}
	return { program, hookable, command: commandLine.trim() };
}

/**
 * What to tell the model when the terminal is inside a shell we can't hook.
 * Not a failure — the session is perfectly usable, just only through the keys
 * rather than through run_command's capture.
 */
export function unhookableShellMessage(shell: NestedShell): string {
	return (
		`The terminal has \`${shell.command}\` open inside it — a second shell, sitting at its own ` +
		'prompt. Haruspex installs its command-capture hooks when it starts a shell, so that inner ' +
		'one has none, and run_command cannot tell when a command it sends there has finished. ' +
		'Drive it with shell_input and read the result with shell_read, or send `exit` to return to ' +
		`the outer shell, where run_command works normally. (To have Haruspex start ${shell.program} ` +
		'as the terminal itself, with hooks: Settings → Shell.)'
	);
}
