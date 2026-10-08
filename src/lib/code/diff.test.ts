import { describe, expect, it } from 'vitest';
import {
	buildEditDiff,
	buildWriteDiff,
	diffLines,
	editDiffFromStep,
	editedLine,
	splitLines,
	toHunks,
	type DiffLine
} from './diff';

const lines = (d: { rows: unknown[] }) =>
	(d.rows as DiffLine[]).map((r) =>
		r.kind === 'ctx'
			? ` ${r.text}`
			: r.kind === 'add'
				? `+${r.text}`
				: r.kind === 'del'
					? `-${r.text}`
					: '…'
	);

describe('splitLines', () => {
	it('drops the empty line a trailing newline makes', () => {
		expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
		expect(splitLines('')).toEqual([]);
		expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
	});
});

describe('diffLines', () => {
	it('keeps shared lines and marks the changed ones', () => {
		const d = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
		expect(d.map((l) => `${l.kind}:${l.text}`)).toEqual(['ctx:a', 'del:b', 'add:x', 'ctx:c']);
		expect(d[2]).toMatchObject({ oldNo: null, newNo: 2 });
		expect(d[3]).toMatchObject({ oldNo: 3, newNo: 3 });
	});

	it('finds lines kept in the middle of a change', () => {
		const d = diffLines(['1', 'a', '2', 'b'], ['a', 'X', 'b', 'Y']);
		expect(d.filter((l) => l.kind === 'ctx').map((l) => l.text)).toEqual(['a', 'b']);
	});
});

describe('toHunks', () => {
	it('folds long unchanged runs into gaps, keeping three lines of context', () => {
		const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
		const after = [...before];
		after[9] = 'changed';
		const rows = toHunks(diffLines(before, after));
		expect(rows[0]).toEqual({ kind: 'gap', skipped: 6 });
		expect(rows.filter((r) => r.kind === 'ctx')).toHaveLength(6);
		expect(rows[rows.length - 1]).toEqual({ kind: 'gap', skipped: 7 });
	});
});

describe('buildEditDiff', () => {
	it('numbers the lines from where the edit landed', () => {
		const d = buildEditDiff('src/a.ts', 'const a = 1;\nfoo();', 'const a = 2;\nfoo();', 41);
		expect(d).toMatchObject({ path: 'src/a.ts', mode: 'edit', added: 1, removed: 1 });
		expect(lines(d)).toEqual(['-const a = 1;', '+const a = 2;', ' foo();']);
		expect((d.rows[0] as DiffLine).oldNo).toBe(41);
		expect((d.rows[2] as DiffLine).newNo).toBe(42);
	});
});

describe('buildWriteDiff', () => {
	it('diffs a rewrite against what the file held', () => {
		const d = buildWriteDiff('notes.txt', 'one\ntwo\n', 'one\nthree\n');
		expect(d).toMatchObject({ mode: 'write', added: 1, removed: 1 });
		expect(lines(d)).toEqual([' one', '-two', '+three']);
	});

	it('shows a new file as all added', () => {
		const d = buildWriteDiff('new.txt', null, 'a\nb\n');
		expect(d).toMatchObject({ mode: 'new', added: 2, removed: 0 });
		expect(lines(d)).toEqual(['+a', '+b']);
	});

	it('keeps the counts but not every row of a huge diff', () => {
		const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
		const d = buildWriteDiff('big.txt', null, big);
		expect(d.added).toBe(3000);
		expect(d.rows).toHaveLength(2000);
		expect(d.truncated).toBe(true);
	});
});

describe('edit steps', () => {
	it('reads the line from the edit tool result', () => {
		expect(editedLine('Edited src/a.ts (line 12) [fuzzy match]')).toBe(12);
		expect(editedLine('{"error":"no match"}')).toBeNull();
	});

	it('builds the diff from the call and its result, or nothing when it failed', () => {
		const args = { path: 'a.ts', old_str: 'x', new_str: 'y' };
		expect(editDiffFromStep({ args, result: 'Edited a.ts (line 3)' })?.added).toBe(1);
		expect(editDiffFromStep({ args, result: '{"error":"no match"}' })).toBeNull();
		expect(editDiffFromStep({ args: { path: 'a.ts' }, result: 'Edited a.ts (line 3)' })).toBeNull();
	});
});
