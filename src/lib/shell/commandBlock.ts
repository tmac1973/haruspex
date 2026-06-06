/**
 * Helpers for turning an LLM-suggested command block (the text behind a
 * shell code-block's Run / Paste buttons) into something safe to inject
 * into the PTY.
 *
 * Two problems this guards against, both seen with interactive shells
 * like fish:
 *   - Comment-only and blank lines in the block each become their own
 *     shell-history entry (and the model sees `# ...` as a "command").
 *   - Injecting the text as raw keystrokes lets the shell's line editor
 *     mangle it — auto-closing quotes (`"1900"` -> `"1"9"0"0"`), syntax
 *     highlight reprints (duplicated text), autosuggestions — which then
 *     corrupts the echo-based command capture.
 */

/**
 * Strip comment-only lines and blank lines from a suggested command
 * block. A line whose first non-whitespace character is `#` is dropped
 * entirely, as are blank lines. Inline trailing comments are left alone —
 * stripping them is unsafe because a `#` can legitimately appear inside a
 * quoted string (e.g. `grep '#define'`).
 */
export function stripCommandComments(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.filter((line) => {
			const t = line.trim();
			return t !== '' && !t.startsWith('#');
		})
		.join('\n');
}

// Bracketed-paste guards. Wrapping injected text in these tells the shell
// (fish/bash/zsh all enable bracketed paste by default in interactive
// mode) to insert it as a literal paste — no autosuggestion, no syntax
// highlight reprints, no auto-closing of quotes.
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Wrap command text as a bracketed paste for safe PTY injection. When
 * `execute` is true a trailing carriage return is appended (outside the
 * paste guards) so the pasted command(s) run; otherwise the text just
 * lands in the prompt for the user to review and run themselves.
 */
export function toBracketedPaste(text: string, execute = false): string {
	return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}${execute ? '\r' : ''}`;
}
