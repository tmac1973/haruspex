import { describe, it, expect } from 'vitest';
import { stripCommandComments, toPtyPaste } from './commandBlock';

describe('stripCommandComments', () => {
	it('drops comment-only and blank lines, keeping commands', () => {
		const block = [
			'# See what UFW rules are active',
			'sudo ufw status verbose',
			'',
			'# Check if a port is allowed',
			'sudo ufw status | grep -E "1900|5355"'
		].join('\n');
		expect(stripCommandComments(block)).toBe(
			'sudo ufw status verbose\nsudo ufw status | grep -E "1900|5355"'
		);
	});

	it('drops indented comment lines', () => {
		expect(stripCommandComments('   # indented comment\n  ls -la')).toBe('  ls -la');
	});

	it('keeps inline trailing comments untouched (could be inside a string)', () => {
		expect(stripCommandComments('echo hello # not stripped')).toBe('echo hello # not stripped');
		expect(stripCommandComments("grep '#define' file.h")).toBe("grep '#define' file.h");
	});

	it('normalizes CRLF line endings', () => {
		expect(stripCommandComments('# c\r\nls\r\n')).toBe('ls');
	});

	it('returns empty string when there is nothing runnable', () => {
		expect(stripCommandComments('# only\n\n  # comments')).toBe('');
		expect(stripCommandComments('')).toBe('');
	});

	it('leaves a single clean command unchanged', () => {
		expect(stripCommandComments('ls -la')).toBe('ls -la');
	});
});

describe('toPtyPaste', () => {
	it('wraps text in bracketed-paste guards without executing by default', () => {
		expect(toPtyPaste('ls -la')).toBe('\x1b[200~ls -la\x1b[201~');
	});

	it('appends a carriage return after the guards when executing', () => {
		expect(toPtyPaste('ls -la', { execute: true })).toBe('\x1b[200~ls -la\x1b[201~\r');
	});

	it('keeps embedded newlines inside the paste (not executed early)', () => {
		const out = toPtyPaste('cmd1\ncmd2', { execute: true });
		expect(out).toBe('\x1b[200~cmd1\ncmd2\x1b[201~\r');
		// The only carriage return is the final execute keystroke.
		expect(out.indexOf('\r')).toBe(out.length - 1);
	});

	// A line editor that doesn't implement bracketed paste (busybox ash over
	// ssh) parses the guards as an unknown escape sequence and swallows them
	// along with adjacent input, so the command loses its first characters.
	it('omits the guards entirely when they are not safe', () => {
		const out = toPtyPaste("dmesg | grep -iE 'quectel|wwan'", { bracketed: false });
		expect(out).toBe("dmesg | grep -iE 'quectel|wwan'");
		expect(out).not.toContain('\x1b');
	});

	it('still appends the execute keystroke without the guards', () => {
		expect(toPtyPaste('ls -la', { execute: true, bracketed: false })).toBe('ls -la\r');
	});
});
