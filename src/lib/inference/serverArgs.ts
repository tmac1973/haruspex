/**
 * Split the "Extra llama-server arguments" setting into argv entries.
 *
 * Whitespace separates arguments; single or double quotes group one that
 * contains spaces, and are removed. Backslashes are kept as typed, never
 * treated as escapes: the most likely thing to paste here is an
 * `--override-tensor` regex such as `blk\.(1|2)\.ffn_.*_exps=CPU`, and a
 * shell-style parser would eat its backslashes. An unclosed quote runs to the
 * end of the string.
 */
export function splitServerArgs(text: string): string[] {
	const args: string[] = [];
	let current = '';
	let inArg = false;
	let quote: '"' | "'" | null = null;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			inArg = true;
		} else if (/\s/.test(ch)) {
			if (inArg) args.push(current);
			current = '';
			inArg = false;
		} else {
			current += ch;
			inArg = true;
		}
	}
	if (inArg) args.push(current);
	return args;
}
