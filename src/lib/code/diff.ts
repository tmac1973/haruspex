/**
 * Line diffs for the Code tab's diff cards.
 *
 * An edit's diff comes from the call itself (`old_str` → `new_str`, placed at
 * the line the edit tool reported). A write's comes from the file as it was
 * before the write, which the write tool reads in the Code tab and attaches to
 * its step (`buildWriteDiff`); a file that did not exist is all added lines.
 *
 * No `diff` package: an LCS over the lines that differ is enough for a card.
 */

export interface DiffLine {
	kind: 'ctx' | 'add' | 'del';
	text: string;
	/** 1-indexed line in the old text; null for an added line. */
	oldNo: number | null;
	/** 1-indexed line in the new text; null for a removed line. */
	newNo: number | null;
}

/** Unchanged lines left out between two hunks. */
export interface DiffGap {
	kind: 'gap';
	skipped: number;
}

export type DiffRow = DiffLine | DiffGap;

export interface FileDiff {
	path: string;
	/** `new`: the write created the file. */
	mode: 'edit' | 'write' | 'new';
	added: number;
	removed: number;
	rows: DiffRow[];
	/** Rows were cut at `MAX_ROWS`; the counts still cover the whole change. */
	truncated?: boolean;
}

/** Unchanged lines kept around each change. */
export const CONTEXT_LINES = 3;
/** Rows kept on a step. The thread is saved whole, so a huge diff isn't. */
export const MAX_ROWS = 2000;
/** Past this many LCS cells, the changed middle is shown as replaced outright. */
const MAX_CELLS = 4_000_000;

/** Lines of `text`, without the empty one a trailing newline would add. */
export function splitLines(text: string): string[] {
	if (text === '') return [];
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * Every line of `a` and `b` as kept, removed or added, in order. Line numbers
 * start at `oldStart` / `newStart`.
 */
export function diffLines(a: string[], b: string[], oldStart = 1, newStart = 1): DiffLine[] {
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (
		suf < a.length - pre &&
		suf < b.length - pre &&
		a[a.length - 1 - suf] === b[b.length - 1 - suf]
	) {
		suf++;
	}
	const midA = a.slice(pre, a.length - suf);
	const midB = b.slice(pre, b.length - suf);

	const out: DiffLine[] = [];
	let o = oldStart;
	let n = newStart;
	const ctx = (text: string) => out.push({ kind: 'ctx', text, oldNo: o++, newNo: n++ });
	const del = (text: string) => out.push({ kind: 'del', text, oldNo: o++, newNo: null });
	const add = (text: string) => out.push({ kind: 'add', text, oldNo: null, newNo: n++ });

	for (let i = 0; i < pre; i++) ctx(a[i]);
	for (const op of middleOps(midA, midB)) {
		if (op.kind === 'ctx') ctx(op.text);
		else if (op.kind === 'del') del(op.text);
		else add(op.text);
	}
	for (let i = a.length - suf; i < a.length; i++) ctx(a[i]);
	return out;
}

/** LCS over the part that differs; too big, and it is all removed then all added. */
function middleOps(a: string[], b: string[]): { kind: DiffLine['kind']; text: string }[] {
	const ops: { kind: DiffLine['kind']; text: string }[] = [];
	if (a.length === 0 || b.length === 0 || (a.length + 1) * (b.length + 1) > MAX_CELLS) {
		for (const t of a) ops.push({ kind: 'del', text: t });
		for (const t of b) ops.push({ kind: 'add', text: t });
		return ops;
	}
	const w = b.length + 1;
	// lcs[i * w + j]: the LCS length of a[i..] and b[j..].
	const lcs = new Uint32Array((a.length + 1) * w);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i * w + j] =
				a[i] === b[j]
					? lcs[(i + 1) * w + j + 1] + 1
					: Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
		}
	}
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			ops.push({ kind: 'ctx', text: a[i] });
			i++;
			j++;
		} else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
			ops.push({ kind: 'del', text: a[i++] });
		} else {
			ops.push({ kind: 'add', text: b[j++] });
		}
	}
	while (i < a.length) ops.push({ kind: 'del', text: a[i++] });
	while (j < b.length) ops.push({ kind: 'add', text: b[j++] });
	return ops;
}

/** Keep `context` unchanged lines around each change; fold the rest into gaps. */
export function toHunks(lines: DiffLine[], context = CONTEXT_LINES): DiffRow[] {
	const keep = new Array<boolean>(lines.length).fill(false);
	lines.forEach((l, i) => {
		if (l.kind === 'ctx') return;
		for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
			keep[k] = true;
		}
	});
	const rows: DiffRow[] = [];
	let skipped = 0;
	lines.forEach((l, i) => {
		if (keep[i]) {
			if (skipped > 0) rows.push({ kind: 'gap', skipped });
			skipped = 0;
			rows.push(l);
		} else {
			skipped++;
		}
	});
	if (skipped > 0 && rows.length > 0) rows.push({ kind: 'gap', skipped });
	return rows;
}

function finish(path: string, mode: FileDiff['mode'], lines: DiffLine[]): FileDiff {
	const all = toHunks(lines);
	const diff: FileDiff = {
		path,
		mode,
		added: lines.filter((l) => l.kind === 'add').length,
		removed: lines.filter((l) => l.kind === 'del').length,
		rows: all.slice(0, MAX_ROWS)
	};
	if (all.length > MAX_ROWS) diff.truncated = true;
	return diff;
}

/** An `fs_edit_text` call: `oldStr` replaced by `newStr` from line `firstLine`. */
export function buildEditDiff(
	path: string,
	oldStr: string,
	newStr: string,
	firstLine: number
): FileDiff {
	const start = Number.isFinite(firstLine) && firstLine > 0 ? firstLine : 1;
	return finish(path, 'edit', diffLines(splitLines(oldStr), splitLines(newStr), start, start));
}

/** An `fs_write_text` call. `before` is null when the file did not exist. */
export function buildWriteDiff(path: string, before: string | null, after: string): FileDiff {
	return finish(
		path,
		before === null ? 'new' : 'write',
		diffLines(splitLines(before ?? ''), splitLines(after))
	);
}

/** The `(line N)` the edit tool reports, or null when the edit failed. */
export function editedLine(result: string | undefined): number | null {
	if (!result || result.trimStart().startsWith('{')) return null;
	const m = /^Edited .*\(line (\d+)\)/.exec(result);
	return m ? Number(m[1]) : null;
}

/** The diff an `fs_edit_text` step shows, or null when it has none. */
export function editDiffFromStep(step: {
	args?: Record<string, unknown>;
	result?: string;
}): FileDiff | null {
	const line = editedLine(step.result);
	const a = step.args ?? {};
	if (line === null || typeof a.old_str !== 'string' || typeof a.new_str !== 'string') return null;
	return buildEditDiff(String(a.path ?? ''), a.old_str, a.new_str, line);
}
