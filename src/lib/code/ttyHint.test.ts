import { describe, it, expect } from 'vitest';
import { needsTerminal, ttyHintFor, TTY_HINT, TTY_HINT_NO_SHELL_TOOL } from './ttyHint.ts';

const failed = (stderr: string, stdout = '') => ({ stdout, stderr, exit_code: 1, killed: false });

describe('needsTerminal', () => {
	it.each([
		[
			'sudo without a tty',
			'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\nsudo: a password is required\n'
		],
		['sudo -n', 'sudo: a password is required\n'],
		['older sudo', 'sudo: no tty present and no askpass program specified\n'],
		['su', 'su: must be run from a terminal\n'],
		['docker -it', 'the input device is not a TTY\n'],
		[
			'gpg',
			"gpg: cannot open '/dev/tty': No such device or address\ngpg: signing failed: Not a tty\n"
		],
		[
			'macOS sudo without a tty',
			'Password:\nsudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\n'
		],
		['macOS sudo before Ventura', 'sudo: no tty present and no askpass program specified\n'],
		['sudo with requiretty', 'sudo: sorry, you must have a tty to run sudo\n'],
		[
			'ssh asking for a password',
			'ssh_askpass: exec(/usr/X11R6/bin/ssh-askpass): No such file or directory\nuser@host: Permission denied (publickey,password).\n'
		],
		['ssh -t', 'Pseudo-terminal will not be allocated because stdin is not a terminal.\n'],
		['vim', 'Vim: Warning: Input is not from a terminal\n'],
		[
			'git asking for a username',
			"fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"
		],
		['macOS /dev/tty', "gpg: cannot open '/dev/tty': Device not configured\n"],
		['stty', "stty: 'standard input': Inappropriate ioctl for device\n"],
		['read -s', 'bash: line 1: read: read error: 0: Inappropriate ioctl for device\n']
	])('matches %s', (_name, output) => {
		expect(needsTerminal(output)).toBe(true);
	});

	it.each([
		['a missing command', 'bash: line 1: foo: command not found\n'],
		['a failing test', 'FAILED tests/test_login.py::test_password_reset - AssertionError\n'],
		['a compiler error', 'error[E0425]: cannot find value `tty` in this scope\n'],
		['a test about ttys', 'FAILED test_tty.py::test_dev_tty_missing - AssertionError\n'],
		['a wrong password', 'sudo: 3 incorrect password attempts\n']
	])('ignores %s', (_name, output) => {
		expect(needsTerminal(output)).toBe(false);
	});
});

describe('ttyHintFor', () => {
	it('hints for a failed sudo, naming open_in_shell', () => {
		const hint = ttyHintFor(failed('sudo: a password is required\n'));
		expect(hint).toBe(TTY_HINT);
		expect(hint).toContain('open_in_shell');
	});

	it('points at the Shell tab where open_in_shell is not offered', () => {
		const hint = ttyHintFor(failed('sudo: a password is required\n'), { openInShell: false });
		expect(hint).toBe(TTY_HINT_NO_SHELL_TOOL);
		expect(hint).not.toContain('open_in_shell');
		expect(hint).toContain('Shell tab');
	});

	it('reads stdout too', () => {
		expect(ttyHintFor(failed('', 'not a tty\n'))).toBe(TTY_HINT);
	});

	it('stays quiet when the command succeeded anyway', () => {
		const res = {
			...failed("stty: 'standard input': Inappropriate ioctl for device\n"),
			exit_code: 0
		};
		expect(ttyHintFor(res)).toBeNull();
	});

	it('stays quiet for a timeout or cancel', () => {
		const res = { ...failed('sudo: a password is required\n'), exit_code: null, killed: true };
		expect(ttyHintFor(res)).toBeNull();
	});

	it('hands a failed Windows elevation to the user, whatever it printed', () => {
		const res = failed('');
		expect(ttyHintFor(res, { openInShell: true, command: 'gsudo choco install git' })).toBe(
			TTY_HINT
		);
		expect(
			ttyHintFor(res, {
				openInShell: true,
				command: "Start-Process pwsh -Verb RunAs -ArgumentList '-c','x'"
			})
		).toBe(TTY_HINT);
		expect(ttyHintFor(failed('Sudo is disabled on this machine.\n'))).toBe(TTY_HINT);
		expect(ttyHintFor(failed('The requested operation requires elevation.\n'))).toBe(TTY_HINT);
		// A Linux sudo that failed for its own reasons isn't one.
		expect(ttyHintFor(res, { openInShell: true, command: 'sudo make install' })).toBeNull();
	});
});
