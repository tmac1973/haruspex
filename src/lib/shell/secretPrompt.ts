/**
 * Spotting a command that stopped to ask for a secret: `sudo`'s password,
 * `su`, `doas`, an ssh key passphrase. While one waits, `run_command` stops
 * its time limit and the Shell tab asks you to type it in the terminal. The
 * agent never answers these: the password goes from your keyboard to the
 * program, and is not echoed, so it never reaches the model.
 *
 * Only the last line counts, and only when the program printed nothing after
 * it: a log line that mentions "password:" mid-output isn't a prompt.
 */

const PROMPTS: RegExp[] = [
	// sudo: "[sudo] password for tim:", and sudo -p's own prompts that keep the word.
	/\[sudo\][^\n]*:\s*$/i,
	// su, passwd, ssh to a host with password auth, doas, mysql -p, polkit's pkexec text mode.
	/\bpassword(?: for [^\n:]+)?:\s*$/i,
	/\bpassword \([^\n)]*\):\s*$/i,
	// ssh-add, ssh, gpg's terminal pinentry.
	/\bpassphrase(?: for [^\n:]+)?:\s*$/i,
	/\benter (?:pin|passphrase)\b[^\n]*:\s*$/i
];

/** The prompt line when `output` ends at one, else null. */
export function secretPrompt(output: string): string | null {
	const lines = output.replace(/\r/g, '').split('\n');
	let last = lines.pop() ?? '';
	// A prompt usually sits on a line of its own with no newline after it, but
	// some programs print one and then read: allow a single trailing break.
	if (!last.trim() && lines.length) last = lines.pop() ?? '';
	const line = last.trim();
	if (!line || line.length > 200) return null;
	return PROMPTS.some((p) => p.test(line)) ? line : null;
}
