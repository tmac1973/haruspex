/**
 * The question in a request's body: quoted text and signatures removed, so a
 * reply in the thread carries only what is new.
 */

/** Longest question passed to the model, in characters. */
export const MAX_QUESTION_CHARS = 8000;

/** The subject without the trigger phrase, or "Re:", and the separators left around it. */
export function stripPhrase(subject: string, phrase: string): string {
	let s = subject.trim();
	const p = phrase.trim();
	if (p) {
		const at = s.toLowerCase().indexOf(p.toLowerCase());
		if (at >= 0) s = s.slice(0, at) + ' ' + s.slice(at + p.length);
	}
	s = s.replace(/^(\s*(re|fwd?)\s*:\s*)+/i, '');
	return s
		.replace(/\s{2,}/g, ' ')
		.replace(/^[\s:–—-]+|[\s:–—-]+$/g, '')
		.trim();
}

/** Whether a quoted original starts at `line`, given the line after it. */
type QuoteMatcher = (line: string, next: string) => boolean;

const QUOTE_STARTS: QuoteMatcher[] = [
	// Gmail and Apple Mail: "On <date>, <name> wrote:", which Gmail may wrap
	// onto a second line.
	(line) => /^On\b.*\bwrote:$/i.test(line),
	(line, next) => /^On\b/i.test(line) && /\bwrote:$/i.test(next),
	// Outlook.
	(line) => /^-{2,}\s*Original Message\s*-{2,}$/i.test(line),
	(line, next) => /^_{10,}$/.test(line) && /^From:/i.test(next),
	(line, next) => /^From:\s/i.test(line) && /^(Sent|Date):\s/i.test(next),
	// Two or more `>` lines in a row.
	(line, next) => line.startsWith('>') && next.startsWith('>')
];

/** Where the quoted original starts: the index of its first line, or -1. */
function quoteStart(lines: string[]): number {
	return lines.findIndex((l, i) => {
		const line = l.trim();
		const next = (lines[i + 1] ?? '').trim();
		return QUOTE_STARTS.some((m) => m(line, next));
	});
}

/** The new text of a request body. Empty bodies fall back to the subject. */
export function requestQuestion(body: string, subject: string, phrase: string): string {
	let lines = body.replace(/\r\n?/g, '\n').split('\n');
	const quote = quoteStart(lines);
	if (quote >= 0) lines = lines.slice(0, quote);
	const sig = lines.findIndex((l) => l === '-- ' || l.trimEnd() === '--');
	if (sig >= 0) lines = lines.slice(0, sig);
	lines = lines.filter((l) => !l.trim().startsWith('>'));
	while (lines.length > 0) {
		const last = lines[lines.length - 1].trim();
		if (last && !/^Sent from my\b/i.test(last)) break;
		lines.pop();
	}
	let text = lines
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	if (!text) text = stripPhrase(subject, phrase);
	return text.length > MAX_QUESTION_CHARS ? text.slice(0, MAX_QUESTION_CHARS) : text;
}
