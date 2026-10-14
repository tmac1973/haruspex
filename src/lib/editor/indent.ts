/**
 * The indent a file already uses, so Tab and Enter add the same: a tab, or
 * the run of spaces its nesting steps by.
 */

/** Read past this many lines and the answer won't change. */
const SAMPLE_LINES = 1000;

/** `'\t'`, a string of spaces, or null when the text has no indented lines. */
export function detectIndent(text: string): string | null {
	let tabs = 0;
	let spaces = 0;
	const steps = new Map<number, number>();
	let previous = 0;
	for (const line of text.split('\n', SAMPLE_LINES)) {
		if (!line.trim()) continue;
		if (line.startsWith('\t')) {
			tabs++;
			previous = 0;
			continue;
		}
		const width = line.length - line.trimStart().length;
		// One space is a block comment's ` * `, not an indent.
		if (width >= 2) spaces++;
		const step = width - previous;
		if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
		previous = width;
	}
	if (tabs === 0 && spaces === 0) return null;
	if (tabs >= spaces) return '\t';
	const best = mostCommon(steps);
	return best ? ' '.repeat(best) : null;
}

/** The step seen most often; the smaller one on a tie. */
function mostCommon(steps: Map<number, number>): number {
	let best = 0;
	let count = 0;
	for (const [step, n] of steps) {
		if (n > count || (n === count && step < best)) [best, count] = [step, n];
	}
	return best;
}
