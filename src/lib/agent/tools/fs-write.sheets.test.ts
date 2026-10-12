import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, ToolExecOutput, ToolRegistration } from './types';

// Spreadsheet validation/normalisation in fs-write.ts (validateSheets,
// validateSheet, normalizeSheets, parseIfJsonArray) and the conflict-check
// path a spreadsheet write goes through. The executors are captured at
// registration so the model's raw arguments reach them without the schema
// coercion executeTool applies first; a few cases go through executeTool to
// pin down what the two layers do together.

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	isAutoApproveActive: vi.fn(() => false),
	askFileConflict: vi.fn(),
	registered: new Map<string, unknown>()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

vi.mock('#lib/stores/approvalOverride.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/approvalOverride.ts')>()),
	isAutoApproveActive: mocks.isAutoApproveActive
}));

vi.mock('#lib/stores/fileConflict.svelte.ts', () => ({
	askFileConflict: mocks.askFileConflict
}));

vi.mock('./registry', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./registry')>();
	return {
		...actual,
		registerTool: (reg: ToolRegistration) => {
			mocks.registered.set(reg.schema.function.name, reg);
			actual.registerTool(reg);
		}
	};
});

import './fs-write';
import { invokeRouter, unexpectedInvoke } from '#lib/testing/invoke.ts';

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
	return {
		workingDir: '/tmp/work',
		pendingImages: [],
		deepResearch: false,
		shellMode: false,
		codeMode: false,
		codeAutoApprove: false,
		filesWrittenThisTurn: new Set<string>(),
		...over
	} as ToolContext;
}

let ctx: ToolContext;

/** Disk state the invoke mock answers from. */
let disk: {
	exists: boolean | Error;
	writeError?: unknown;
	available?: string | Error;
	written: { command: string; payload: Record<string, unknown> }[];
};

beforeEach(() => {
	ctx = makeCtx();
	disk = { exists: false, written: [] };
	mocks.isAutoApproveActive.mockReset().mockReturnValue(false);
	mocks.askFileConflict.mockReset();
	const write = (command: string) => (payload?: Record<string, unknown>) => {
		if (disk.writeError !== undefined) throw disk.writeError;
		disk.written.push({ command, payload: payload! });
		return undefined;
	};
	mocks.invoke.mockReset().mockImplementation(
		invokeRouter(
			{
				fs_path_exists: () => {
					if (disk.exists instanceof Error) throw disk.exists;
					return disk.exists;
				},
				fs_find_available_path: () => {
					if (disk.available instanceof Error) throw disk.available;
					return disk.available;
				},
				fs_write_xlsx: write('fs_write_xlsx'),
				fs_write_ods: write('fs_write_ods')
			},
			unexpectedInvoke
		)
	);
});

function executor(name: string) {
	const reg = mocks.registered.get(name) as ToolRegistration | undefined;
	if (!reg) throw new Error(`${name} was not registered`);
	return reg.execute;
}

/** Call the xlsx executor directly, with the model's arguments as-is. */
function xlsx(sheets: unknown, path = 'out.xlsx'): Promise<ToolExecOutput> {
	return executor('fs_write_xlsx')({ path, sheets }, ctx);
}

function errorOf(out: ToolExecOutput): string {
	return (JSON.parse(out.result) as { error: string }).error;
}

function sentSheets(): { name: string; rows: unknown[] }[] {
	expect(disk.written).toHaveLength(1);
	return disk.written[0].payload.sheets as { name: string; rows: unknown[] }[];
}

const GOOD = [
	{
		name: 'S',
		rows: [
			['Name', 'Score'],
			['Alice', '95']
		]
	}
];

describe('sheets that are not an array', () => {
	it.each([
		['undefined', undefined],
		['null', null],
		['a number', 42],
		['an object', { name: 'S', rows: [['a'], ['b']] }],
		['plain text', 'Name,Score\nAlice,95'],
		['a JSON object string', '{"name":"S","rows":[["a"],["b"]]}'],
		['malformed JSON', '[{"name":"S","rows":[["a"],'],
		['an empty array', []],
		['an empty JSON array string', '[]']
	])('rejects %s', async (_label, sheets) => {
		const out = await xlsx(sheets);
		expect(errorOf(out)).toMatch(/non-empty array/);
		expect(disk.written).toHaveLength(0);
	});
});

describe('sheets sent as a JSON string', () => {
	it.each([
		['bare', JSON.stringify(GOOD)],
		['with surrounding whitespace', `\n  ${JSON.stringify(GOOD)}  \n`]
	])('parses a JSON array string, %s, and writes it', async (_label, sheets) => {
		expect((await xlsx(sheets)).result).toBe('Wrote: out.xlsx');
		expect(sentSheets()).toEqual(GOOD);
	});

	it('coerces bare numbers inside the parsed string to strings', async () => {
		const out = await xlsx('[{"name":"S","rows":[["n","sq"],[2,4],[3,9]]}]');
		expect(out.result).toBe('Wrote: out.xlsx');
		expect(sentSheets()[0].rows).toEqual([
			['n', 'sq'],
			['2', '4'],
			['3', '9']
		]);
	});

	it('parses rows sent as a JSON string inside a real sheet', async () => {
		const rows = '[["a","b"],["1","2"]]';
		expect((await xlsx([{ name: 'S', rows }])).result).toBe('Wrote: out.xlsx');
		expect(sentSheets()[0].rows).toEqual(JSON.parse(rows));
	});
});

describe('through executeTool (schema coercion first)', () => {
	async function viaRegistry(sheets: unknown) {
		const { executeTool } = await import('./registry');
		return executeTool('fs_write_xlsx', { path: 'out.xlsx', sheets }, ctx);
	}

	it('wraps a single bare sheet object into a one-sheet array', async () => {
		const out = await viaRegistry(GOOD[0]);
		expect(out.result).toBe('Wrote: out.xlsx');
		expect(sentSheets()).toEqual(GOOD);
	});

	it('parses a JSON array string, as the executor would itself', async () => {
		const out = await viaRegistry(JSON.stringify(GOOD));
		expect(out.result).toBe('Wrote: out.xlsx');
	});

	it('still rejects plain text', async () => {
		const out = await viaRegistry('Name, Score');
		expect(errorOf(out)).toMatch(/non-empty array/);
	});
});

describe('malformed sheet entries', () => {
	it('reports a sheet with no rows field', async () => {
		expect(errorOf(await xlsx([{ name: 'S' }]))).toMatch(/Sheet 1 has no rows/);
	});

	it.each([
		['a string', 'Sheet1'],
		['a number', 7],
		['null', null],
		['an array', [['A'], ['x']]]
	])('reports a sheet given as %s', async (_label, sheet) => {
		const out = await xlsx([sheet]);
		expect(errorOf(out)).toMatch(/^Sheet 1 is not an object/);
		expect(disk.written).toHaveLength(0);
	});

	it('names the failing sheet by its position', async () => {
		const out = await xlsx([GOOD[0], { name: 'Empty', rows: [] }]);
		expect(errorOf(out)).toMatch(/^Sheet 2 has no rows/);
	});

	it.each([
		['data rows', [['A'], 'Alice', 42], 2],
		['a stray row among real ones', [['A'], ['x'], 'stray'], 3],
		['the header row', ['Name', ['Alice', '']], 1]
	])('rejects %s that are not arrays', async (_label, rows, n) => {
		expect(errorOf(await xlsx([{ name: 'S', rows }]))).toMatch(`Sheet 1 row ${n} is not an array`);
		expect(disk.written).toHaveLength(0);
	});

	it('treats whitespace-only cells as blank', async () => {
		const out = await xlsx([{ name: 'S', rows: [['A'], ['   '], ['\t\n']] }]);
		expect(errorOf(out)).toMatch(/only a header row/);
	});
});

describe('cell normalisation', () => {
	it('turns null and undefined cells into empty strings and keeps the rest', async () => {
		const out = await xlsx([
			{
				name: 'S',
				rows: [
					['A', 'B', 'C'],
					['x', null, 1.5],
					['y', 'z', undefined]
				]
			}
		]);
		expect(out.result).toBe('Wrote: out.xlsx');
		expect(sentSheets()[0].rows).toEqual([
			['A', 'B', 'C'],
			['x', '', '1.5'],
			['y', 'z', '']
		]);
	});

	it.each([
		['an object', { v: 1 }],
		['a list', [1, 2]]
	])('rejects %s as a cell', async (_label, cell) => {
		const out = await xlsx([
			{
				name: 'S',
				rows: [
					['A', 'B'],
					['x', cell]
				]
			}
		]);
		expect(errorOf(out)).toMatch(/^Sheet 1 row 2 cell 2 is an object or list/);
		expect(disk.written).toHaveLength(0);
	});

	it('keeps other sheet fields and does not mutate the input', async () => {
		const input = [{ name: 'S', extra: 'kept', rows: [['A'], [1]] }];
		await xlsx(input);
		expect(sentSheets()[0]).toEqual({ name: 'S', extra: 'kept', rows: [['A'], ['1']] });
		expect(input[0].rows[1][0]).toBe(1);
	});
});

describe('ragged rows', () => {
	it('accepts short rows as long as every named column has data somewhere', async () => {
		const rows = [['Name', 'Age', 'City'], ['Alice', '30'], ['Bob'], ['Carol', '', 'Leeds']];
		const out = await xlsx([{ name: 'S', rows }]);
		expect(out.result).toBe('Wrote: out.xlsx');
		expect(sentSheets()[0].rows).toEqual(rows);
	});

	it('rejects when a named column is missing from every short row', async () => {
		const out = await xlsx([
			{
				name: 'S',
				rows: [
					['Name', 'Age', 'City'],
					['Alice', '30'],
					['Bob', '41']
				]
			}
		]);
		expect(errorOf(out)).toMatch(/column "City" is entirely blank/);
	});

	it('skips the blank-column check for an unlabelled header column', async () => {
		const out = await xlsx([{ name: 'S', rows: [['Name', ''], ['Alice'], ['Bob']] }]);
		expect(out.result).toBe('Wrote: out.xlsx');
	});

	it('quotes a trimmed header in the blank-column error', async () => {
		const out = await xlsx([
			{
				name: 'S',
				rows: [
					['Name', '  Total  '],
					['A', ''],
					['B', '']
				]
			}
		]);
		expect(errorOf(out)).toMatch(/column "Total" is entirely blank/);
	});

	it('names a numeric header in the blank-column error', async () => {
		const out = await xlsx([{ name: 'S', rows: [['Name', 2024], ['A'], ['B']] }]);
		expect(errorOf(out)).toMatch(/column "2024" is entirely blank/);
	});

	it('allows a data row up to twice the header width', async () => {
		// 2-col header, 6-cell row: 6 > 2*2 but not > 2+4.
		const out = await xlsx([
			{
				name: 'S',
				rows: [
					['A', 'B'],
					['1', '2', '3', '4', '5', '6']
				]
			}
		]);
		expect(out.result).toBe('Wrote: out.xlsx');
	});

	it('rejects a data row past both limits', async () => {
		const out = await xlsx([
			{
				name: 'S',
				rows: [
					['A', 'B'],
					['1', '2'],
					['1', '2', '3', '4', '5', '6', '7']
				]
			}
		]);
		expect(errorOf(out)).toBe(
			'Sheet 1 data row 2 has 7 cells but the header has 2. Each data row must have one cell per ' +
				'header column — emit one row per record, not all records crammed into a single row.'
		);
	});

	it('applies the 2x limit for wide headers', async () => {
		const header = Array.from({ length: 10 }, (_, i) => `c${i}`);
		const row = (n: number) => Array.from({ length: n }, (_, i) => String(i));
		expect((await xlsx([{ name: 'S', rows: [header, row(20)] }])).result).toBe('Wrote: out.xlsx');
		ctx = makeCtx();
		disk.written = [];
		expect(errorOf(await xlsx([{ name: 'S', rows: [header, row(21)] }]))).toMatch(
			/has 21 cells but the header has 10/
		);
	});
});

describe('placeholder rows', () => {
	it.each(['/data', ' /formula ', '/FILL_ME'])(
		'rejects a lone %j cell in a multi-column sheet',
		async (cell) => {
			const out = await xlsx([{ name: 'S', rows: [['A', 'B'], ['x', 'y'], [cell]] }]);
			expect(errorOf(out)).toMatch(/placeholder-style row/);
		}
	);

	it('accepts slash words as the data of a single-column sheet', async () => {
		const rows = [['Command'], ['/help'], ['/etc']];
		const out = await xlsx([{ name: 'S', rows }]);
		expect(out.result).toBe('Wrote: out.xlsx');
		expect(sentSheets()[0].rows).toEqual(rows);
	});

	it.each([
		['a path with two segments', ['/usr/bin']],
		['a slash command beside other cells', ['/data', 'more']],
		['a slash with digits', ['/2024']]
	])('accepts %s', async (_label, row) => {
		const out = await xlsx([{ name: 'S', rows: [['A', 'B'], ['x', 'y'], row] }]);
		expect(out.result).toBe('Wrote: out.xlsx');
	});
});

describe('fs_write_ods', () => {
	it('runs the same validation, then writes through its own command', async () => {
		const ods = (sheets: unknown) => executor('fs_write_ods')({ path: 'o.ods', sheets }, ctx);
		expect(errorOf(await ods([]))).toMatch(/non-empty array/);
		expect((await ods(GOOD)).result).toBe('Wrote: o.ods');
		expect(disk.written[0].command).toBe('fs_write_ods');
	});
});

describe('write conflicts and failures', () => {
	it('treats a failed existence check as a new file', async () => {
		disk.exists = new Error('permission denied');
		const out = await xlsx(GOOD);
		expect(out.result).toBe('Wrote: out.xlsx');
		expect(disk.written[0].payload.overwrite).toBe(false);
	});

	it('reports a backend write failure and does not count the file as written', async () => {
		disk.writeError = new Error('disk full');
		const out = await xlsx(GOOD);
		expect(errorOf(out)).toBe('fs_write_xlsx failed: disk full');
		expect(ctx.filesWrittenThisTurn.has('out.xlsx')).toBe(false);
	});

	it('reports a non-Error rejection as text', async () => {
		disk.writeError = 'locked by another process';
		const out = await xlsx(GOOD);
		expect(errorOf(out)).toBe('fs_write_xlsx failed: locked by another process');
	});

	it('refuses a second spreadsheet write to the same path in one turn', async () => {
		expect((await xlsx(GOOD)).result).toBe('Wrote: out.xlsx');
		const second = await xlsx(GOOD);
		expect(errorOf(second)).toMatch(/already written in this turn/);
		expect(disk.written).toHaveLength(1);
	});

	it('overwrites an existing file in an unattended run', async () => {
		disk.exists = true;
		mocks.isAutoApproveActive.mockReturnValue(true);
		const out = await xlsx(GOOD);
		expect(out.result).toBe('Wrote: out.xlsx');
		expect(disk.written[0].payload.overwrite).toBe(true);
	});

	it('overwrites an existing file without asking in a Code session', async () => {
		disk.exists = true;
		ctx = makeCtx({ codeSessionId: 'sess-1' } as Partial<ToolContext>);
		const out = await xlsx(GOOD);
		expect(out.result).toBe('Wrote: out.xlsx');
		expect(disk.written[0].payload.overwrite).toBe(true);
	});

	it('returns a stop-and-ask error when the user cancels', async () => {
		disk.exists = true;
		mocks.askFileConflict.mockResolvedValue('cancel');
		const out = await xlsx(GOOD);
		expect(errorOf(out)).toMatch(/^User canceled the fs_write_xlsx write\. The file "out\.xlsx"/);
		expect(disk.written).toHaveLength(0);
	});

	it('writes to the free name the backend finds when the user keeps both', async () => {
		disk.exists = true;
		disk.available = 'out (1).xlsx';
		mocks.askFileConflict.mockResolvedValue('counter');
		const out = await xlsx(GOOD);
		expect(out.result).toBe('Wrote: out (1).xlsx');
		expect(disk.written[0].payload).toMatchObject({ relPath: 'out (1).xlsx', overwrite: false });
		expect(ctx.filesWrittenThisTurn.has('out (1).xlsx')).toBe(true);
	});

	it('leaves the file alone when no free name can be found', async () => {
		disk.exists = true;
		disk.available = new Error('too many copies');
		mocks.askFileConflict.mockResolvedValue('counter');
		const out = await xlsx(GOOD);
		expect(errorOf(out)).toMatch(/no free name could be found next to it \(too many copies\)/);
		expect(disk.written).toHaveLength(0);
	});
});
