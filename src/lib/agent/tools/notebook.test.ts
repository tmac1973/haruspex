import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotebookCard, RowOp } from '#lib/notebooks/api.ts';

const api = vi.hoisted(() => ({
	getCard: vi.fn(),
	getRows: vi.fn(),
	applyRows: vi.fn(),
	listNotebooks: vi.fn(),
	createNotebook: vi.fn(),
	addCard: vi.fn()
}));

vi.mock('#lib/notebooks/api.ts', async (orig) => ({
	...(await orig<typeof import('#lib/notebooks/api.ts')>()),
	...api
}));
vi.mock('#lib/notebooks/source.ts', () => ({
	appLookups: async () => ({}),
	sourceFromToolContext: async () => ({ kind: 'chat', ref: 'c1', label: 'Speakers' })
}));
vi.mock('#lib/stores/notebooks.svelte.ts', () => ({ emitNotebookChanged: vi.fn() }));

import { executeTool } from './registry';
import './notebook-table';
import { resolveNotebook } from './_notebookShared';
import {
	cardOutline,
	checkCsvWidths,
	checklistRows,
	parseUpdates,
	rowsToCsv,
	tableFromCsv
} from './_notebookFormat';
import type { Column } from '#lib/notebooks/columns.ts';
import type { ToolContext } from './types';

/** An update op's cells, parsed. */
function cellsOfOp(op: RowOp): Record<string, unknown> {
	if (!('cells' in op)) throw new Error('not an update');
	return JSON.parse(op.cells);
}

const COLS: Column[] = [
	{ id: 'name', name: 'Name', type: 'text' },
	{ id: 'price', name: 'Price', type: 'currency' }
];

function table(version = 3): NotebookCard {
	return {
		id: 'c1',
		notebook_id: 'n1',
		position: 1,
		kind: 'table',
		title: 'Models',
		body: '',
		meta: JSON.stringify({ columns: COLS }),
		version,
		source: '{"kind":"user"}',
		created_at: 0,
		updated_at: 0,
		deleted_at: null,
		row_count: 2,
		rows: [
			{ id: 'r1', position: 1, cells: '{"name":"Soundcore","price":79.99}' },
			{ id: 'r2', position: 2, cells: '{"name":"JBL","price":129}' }
		]
	};
}

const ctx = { workingDir: null, shellMode: false, codeMode: false } as unknown as ToolContext;

async function run(name: string, args: Record<string, unknown>): Promise<string> {
	const out = await executeTool(name, args, ctx);
	return out.result;
}

describe('notebook tool helpers', () => {
	it('writes rows as CSV with row ids and typed headers', () => {
		const c = table();
		expect(rowsToCsv(c, c.rows)).toBe(
			'row_id,Name:text,Price:currency\nr1,Soundcore,79.99\nr2,JBL,129'
		);
		expect(cardOutline(c)).toContain('[c1] table "Models" — 2 rows');
	});

	it('merges updates into the current cells, typed by column', () => {
		const current = new Map([
			['r1', { name: 'Soundcore', price: 79.99 }],
			['r2', { name: 'JBL', price: 129 }]
		]);
		const ops = parseUpdates('r2: price=$99.50; Name=JBL Flip 6', COLS, current);
		expect(ops).toEqual([
			{ op: 'update', row_id: 'r2', cells: '{"name":"JBL Flip 6","price":99.5}' }
		]);
	});

	it('names the real columns when one is unknown', () => {
		expect(() => parseUpdates('r1: Colour=red', COLS, new Map([['r1', {}]]))).toThrow(
			/Columns: Name, Price/
		);
		expect(() => parseUpdates('r9: Name=x', COLS, new Map())).toThrow(/No row r9/);
	});

	it('keeps ";" and "=" inside a value unless a column name follows', () => {
		const current = new Map([['r1', {}]]);
		const ops = parseUpdates(
			'r1: Name=set -a; . /etc/env; set +a; env | grep x; Price=5',
			COLS,
			current
		);
		expect(cellsOfOp(ops[0])).toEqual({
			name: 'set -a; . /etc/env; set +a; env | grep x',
			price: 5
		});
		const eq = parseUpdates(
			'r1: Name=Custom Model = X and Base URL = http://h:1/v1',
			COLS,
			current
		);
		expect(cellsOfOp(eq[0]).name).toBe('Custom Model = X and Base URL = http://h:1/v1');
	});

	it('refuses an unknown column after ";" and points at the JSON form', () => {
		expect(() => parseUpdates('r1: Name=x; Colour=red', COLS, new Map([['r1', {}]]))).toThrow(
			/"Colour" after a ";" is no column.*JSON/
		);
	});

	it('takes updates as JSON', () => {
		const current = new Map([['r1', { name: 'Old', price: 1 }]]);
		const ops = parseUpdates('{"r1": {"Name": "a; b=c", "Price": 7}}', COLS, current);
		expect(cellsOfOp(ops[0])).toEqual({ name: 'a; b=c', price: 7 });
		const obj = parseUpdates({ r1: { Price: null } }, COLS, current);
		expect(cellsOfOp(obj[0])).toEqual({ name: 'a; b=c' });
		expect(() => parseUpdates('{"r1": {"Colour": "red"}}', COLS, current)).toThrow(/No column/);
		expect(() => parseUpdates('{"r1": ', COLS, current)).toThrow(/valid JSON/);
	});

	it('refuses CSV rows wider than the header', () => {
		expect(() => checkCsvWidths(['a', 'b'], [['1', '2', '']])).not.toThrow();
		expect(() =>
			checkCsvWidths(
				['a', 'b'],
				[
					['1', '2'],
					['x', 'y', 'z']
				]
			)
		).toThrow(/2 columns, but row 2 has 3 fields.*quotes/);
		expect(() => tableFromCsv('Name,Note\nA,one, two')).toThrow(/row 1 has 3 fields/);
	});

	it('reads checklist items with done marks', () => {
		expect(checklistRows('- [x] Buy\n[ ] Test\nPlain\n\n')).toEqual([
			'{"text":"Buy","done":true}',
			'{"text":"Test","done":false}',
			'{"text":"Plain","done":false}'
		]);
	});

	it('makes a typed table from CSV', () => {
		const t = tableFromCsv('Name,Price:currency,Link\nA,$5,https://a.com');
		expect(JSON.parse(t.meta).columns.map((c: Column) => c.type)).toEqual([
			'text',
			'currency',
			'url'
		]);
		expect(t.rows).toEqual(['{"name":"A","price":5,"link":"https://a.com"}']);
		expect(() => tableFromCsv('')).toThrow(/header/);
	});
});

describe('resolveNotebook', () => {
	beforeEach(() => {
		api.listNotebooks.mockResolvedValue([
			{ id: 'n1', title: 'Speakers' },
			{ id: 'n2', title: 'Ideas' },
			{ id: 'n3', title: 'ideas' }
		]);
	});

	it('finds by id or exact title', async () => {
		expect((await resolveNotebook('n1')).id).toBe('n1');
		expect((await resolveNotebook('speakers')).id).toBe('n1');
	});

	it('asks for an id when titles clash, and lists notebooks when none match', async () => {
		await expect(resolveNotebook('Ideas')).rejects.toThrow(/n2, n3/);
		await expect(resolveNotebook('Nope')).rejects.toThrow(/Speakers \(n1\)/);
	});
});

describe('notebook_table_rows', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.getCard.mockResolvedValue(table());
		api.getRows.mockResolvedValue(table().rows);
		api.applyRows.mockImplementation(async () => ({ ...table(4), row_count: 2 }));
	});

	it('changes one row with one update op', async () => {
		const text = await run('notebook_table_rows', { card: 'c1', update: 'r1: Price=69' });
		expect(api.applyRows).toHaveBeenCalledWith(
			'c1',
			3,
			[{ op: 'update', row_id: 'r1', cells: '{"name":"Soundcore","price":69}' }],
			{ kind: 'chat', ref: 'c1', label: 'Speakers' }
		);
		expect(text).toContain('updated 1');
	});

	it('adds rows from CSV and refuses unknown columns', async () => {
		await run('notebook_table_rows', { card: 'c1', add_csv: 'Name,Price\nBose,149' });
		expect(api.applyRows.mock.calls[0][2]).toEqual([
			{ op: 'add', after: null, cells: '{"name":"Bose","price":149}' }
		]);
		const err = await run('notebook_table_rows', { card: 'c1', add_csv: 'Colour\nred' });
		expect(err).toMatch(/No column \\"Colour\\"/);
	});

	it('adds nothing when a CSV row has an unquoted comma', async () => {
		const err = await run('notebook_table_rows', {
			card: 'c1',
			add_csv: 'Name,Price\nBose,149\nSony, the big one,99'
		});
		expect(err).toMatch(/row 2 has 3 fields/);
		expect(api.applyRows).not.toHaveBeenCalled();
	});

	it('re-reads once on a clash, then gives up', async () => {
		api.applyRows.mockRejectedValueOnce('conflict');
		await run('notebook_table_rows', { card: 'c1', delete: 'r2' });
		expect(api.applyRows).toHaveBeenCalledTimes(2);
		api.applyRows.mockRejectedValue('conflict');
		const err = await run('notebook_table_rows', { card: 'c1', delete: 'r2' });
		expect(err).toMatch(/read it again/);
	});

	it('refuses a card that is not a table', async () => {
		api.getCard.mockResolvedValue({ ...table(), kind: 'text' });
		expect(await run('notebook_table_rows', { card: 'c1', delete: 'r1' })).toMatch(/not a table/);
	});
});
