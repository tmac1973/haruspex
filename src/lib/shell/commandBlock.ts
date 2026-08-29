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

export interface PtyPasteOptions {
	/** Append a trailing CR (outside the guards) so the command(s) run. */
	execute?: boolean;
	/**
	 * Wrap in bracketed-paste guards. Default true.
	 *
	 * Only pass false when our own shell's line editor is NOT the thing
	 * reading the bytes — i.e. a command is in flight and owns the terminal's
	 * stdin. The guards are an ANSI escape sequence: a line editor that
	 * implements bracketed paste strips them, but one that doesn't (busybox
	 * ash on an OpenWrt box reached over ssh, say) parses `ESC [ 2 0 0 ~` as an
	 * unknown escape sequence and swallows it *along with adjacent buffered
	 * input* — so the command arrives with its first several characters
	 * missing. Raw text is what a native terminal paste sends anyway, and the
	 * mangling the guards protect against (fish auto-closing quotes,
	 * autosuggestions, highlight reprints) is a property of OUR shell, which
	 * isn't reading in that case.
	 */
	bracketed?: boolean;
}

/**
 * Prepare command text for injection into the PTY. Guards on by default;
 * see `PtyPasteOptions.bracketed` for when to turn them off.
 */
export function toPtyPaste(text: string, opts: PtyPasteOptions = {}): string {
	const { execute = false, bracketed = true } = opts;
	const body = bracketed ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text;
	return `${body}${execute ? '\r' : ''}`;
}
