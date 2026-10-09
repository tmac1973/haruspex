/**
 * Spot a one-shot command that failed because it wanted a terminal.
 *
 * The coding tools run commands with stdin closed and no TTY, so `sudo`,
 * `su`, `ssh` password prompts and anything that calls `isatty` fail at once
 * instead of waiting. Without a hint the model retries the same command or
 * tries to pipe a password into it; with one it hands the command to the user.
 */

/** What these failures print. Matched case-insensitively against stdout + stderr. */
const PATTERNS: RegExp[] = [
	// sudo: a terminal is required to read the password; either use the -S option…
	/\ba terminal is required\b/i,
	// sudo -n, or sudo with no askpass: "sudo: a password is required"
	/\ba password is required\b/i,
	// older sudo: "sudo: no tty present and no askpass program specified"
	/\bno tty present\b/i,
	// su: must be run from a terminal
	/\bmust be run from a terminal\b/i,
	// docker run -it: "the input device is not a TTY"; ssh, gpg, stty: "not a tty"
	/\bnot a tty\b/i,
	// stty, read -s, and anything else that ioctls stdin
	/\binappropriate ioctl for device\b/i
];

/** The note appended to the tool result in the Code tab, which has `open_in_shell`. */
export const TTY_HINT =
	'This command needs an interactive terminal (a password prompt or a TTY), which run_command does not have. ' +
	'Do not retry it here or try to feed it a password. Hand it to the user with open_in_shell: ' +
	'it opens a Shell tab with the command typed in, the user runs it, and you get the result.';

/** The note where there is no `open_in_shell` (the Shell's Code mode without a live terminal). */
export const TTY_HINT_NO_SHELL_TOOL =
	'This command needs an interactive terminal (a password prompt or a TTY), which run_command does not have. ' +
	'Do not retry it here or try to feed it a password. Ask the user to run it in the Shell tab, then continue from what they report.';

/** True when the output reads like a failure for want of a terminal. */
export function needsTerminal(output: string): boolean {
	return PATTERNS.some((p) => p.test(output));
}

/**
 * The hint for a finished command, or null. Only a failed command gets one:
 * a successful build whose shell profile grumbled about `stty` doesn't need it.
 * `openInShell`: the turn has the `open_in_shell` tool (the Code tab).
 */
export function ttyHintFor(
	res: {
		stdout: string;
		stderr: string;
		exit_code: number | null;
		killed: boolean;
	},
	opts: { openInShell: boolean } = { openInShell: true }
): string | null {
	if (res.killed || res.exit_code === 0) return null;
	if (!needsTerminal(`${res.stdout}\n${res.stderr}`)) return null;
	return opts.openInShell ? TTY_HINT : TTY_HINT_NO_SHELL_TOOL;
}
