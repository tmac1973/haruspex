/**
 * A few facts read off a tool result, for the stub that replaces it when the
 * context fit trims it: how big it was, how a command ended, a test run's
 * totals, the first error. Read by code, never a model, so the same result
 * always gives the same receipt.
 *
 * Often enough to answer from without the text itself: "did the tests pass" is
 * in the receipt; "what did line 400 say" is a `recall`. The idea is from
 * mnemonic-proxy (#1022).
 */

const MAX_RECEIPT_CHARS = 320;
const MAX_LINE_CHARS = 160;

/** What `text` says about itself, in one short line, or '' for nothing. */
export function receiptFor(text: string): string {
	const facts = [size(text)];
	for (const fact of [
		errorJson(text),
		source(text),
		exitStatus(text),
		testTotals(text),
		firstError(text),
		spill(text)
	]) {
		if (fact) facts.push(fact);
	}
	const receipt = facts.join('. ') + '.';
	return receipt.length > MAX_RECEIPT_CHARS
		? receipt.slice(0, MAX_RECEIPT_CHARS - 1) + '…'
		: receipt;
}

function size(text: string): string {
	const lines = text.length === 0 ? 0 : text.split('\n').length;
	const bytes = new TextEncoder().encode(text).length;
	const amount = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
	return `${lines} line${lines === 1 ? '' : 's'}, ${amount}`;
}

function clip(line: string): string {
	const t = line.trim();
	return t.length > MAX_LINE_CHARS ? t.slice(0, MAX_LINE_CHARS - 1) + '…' : t;
}

/** `{"error": "…"}`, the shape every tool's failure takes. */
function errorJson(text: string): string {
	if (!text.startsWith('{"error"')) return '';
	try {
		const err = (JSON.parse(text) as { error?: unknown }).error;
		return typeof err === 'string' ? `Error: «${clip(err)}»` : '';
	} catch {
		return '';
	}
}

/** The `[Source: url]` header the loop puts on a fetched page. */
function source(text: string): string {
	const m = /^\[Source: ([^\]\s]+)\]/.exec(text);
	return m ? `Source: ${m[1].slice(0, 120)}` : '';
}

/** run_command's first line: `Exit code: 1 (812ms)`, or a killed command. */
function exitStatus(text: string): string {
	const m = /^Exit code: (-?\d+|none|unknown)/m.exec(text);
	if (m) return `Exit code ${m[1]}`;
	if (/^Command killed/m.test(text)) return 'Killed (timeout or cancel)';
	if (/^Command interrupted/m.test(text)) return 'Interrupted';
	return '';
}

/**
 * A test runner's totals, from the last summary line that has any: pytest's
 * `1 failed, 86 passed in 2.1s`, vitest's `Tests  1 failed | 86 passed`,
 * cargo's `test result: FAILED. 86 passed; 1 failed`.
 */
function testTotals(text: string): string {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!/\b\d+ (passed|failed)\b/.test(line)) continue;
		const counts: string[] = [];
		for (const word of ['passed', 'failed', 'errors?', 'skipped']) {
			const m = new RegExp(`\\b(\\d+) (${word})\\b`).exec(line);
			if (m) counts.push(`${m[1]} ${m[2]}`);
		}
		return `Tests: ${counts.join(', ')}`;
	}
	return '';
}

const ERROR_LINE =
	/(^|[\s:[(])(error\b|Error:|ERROR\b|FAILED\b|FAIL\b|panicked at|Traceback \(most recent)|\b[A-Z][A-Za-z0-9]*(Error|Exception):/;
const ERROR_TYPE = /\b([A-Z][A-Za-z0-9]*(?:Error|Exception))\b/;

/** The first line that reports an error, with its type when it names one. */
function firstError(text: string): string {
	for (const line of text.split('\n')) {
		// A summary that counts zero failures is not an error line.
		if (!ERROR_LINE.test(line) || /\b0 (failed|errors?)\b/.test(line)) continue;
		const type = ERROR_TYPE.exec(line)?.[1];
		return `First error${type ? ` (${type})` : ''}: «${clip(line)}»`;
	}
	return '';
}

/** Where a capped command's whole output was saved. */
function spill(text: string): string {
	const m = /Full output \((\d+) bytes\) saved to (\S+?)(?: —|\s|$)/.exec(text);
	return m ? `Full output in ${m[2]}` : '';
}
