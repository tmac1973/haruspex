import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	logDebug: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

vi.mock('$lib/debug-log', () => ({
	logDebug: mocks.logDebug
}));

// fs-write registers tools as side effect of import; the registry
// route uses executeTool.
const ctx = {
	workingDir: '/tmp/work',
	pendingImages: [],
	deepResearch: false,
	shellMode: false,
	shellAllowWrite: false,
	filesWrittenThisTurn: new Set<string>()
};

beforeEach(() => {
	mocks.invoke.mockReset();
});

async function callXlsx(args: unknown) {
	const { executeTool } = await import('$lib/agent/tools');
	return executeTool('fs_write_xlsx', args as Record<string, unknown>, ctx);
}

describe('fs_write_xlsx input validation', () => {
	it('rejects an empty sheets array without invoking the backend', async () => {
		const out = await callXlsx({ path: 'out.xlsx', sheets: [] });
		expect(JSON.parse(out.result).error).toMatch(/non-empty array/i);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('rejects a sheet with zero rows', async () => {
		const out = await callXlsx({ path: 'out.xlsx', sheets: [{ name: 'S', rows: [] }] });
		expect(JSON.parse(out.result).error).toMatch(/no rows/i);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('rejects a sheet with only a header row', async () => {
		const out = await callXlsx({
			path: 'out.xlsx',
			sheets: [{ name: 'S', rows: [['Header', 'Other']] }]
		});
		expect(JSON.parse(out.result).error).toMatch(/header row/i);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('rejects a sheet whose data rows are all empty', async () => {
		const out = await callXlsx({
			path: 'out.xlsx',
			sheets: [{ name: 'S', rows: [['A', 'B'], [], ['', '']] }]
		});
		expect(JSON.parse(out.result).error).toMatch(/header row/i);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('rejects a placeholder directive like ["/formula"]', async () => {
		const out = await callXlsx({
			path: 'out.xlsx',
			sheets: [{ name: 'S', rows: [['N', 'F(N)'], ['/formula']] }]
		});
		expect(JSON.parse(out.result).error).toMatch(/placeholder/i);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('accepts real data and forwards to the backend', async () => {
		// Two invocations expected: fs_path_exists check (false), then fs_write_xlsx.
		mocks.invoke
			.mockResolvedValueOnce(false) // fs_path_exists
			.mockResolvedValueOnce(undefined); // fs_write_xlsx

		const out = await callXlsx({
			path: 'fib.xlsx',
			sheets: [
				{
					name: 'Fibonacci',
					rows: [
						['N', 'F(N)'],
						['1', '0'],
						['2', '1'],
						['3', '1']
					]
				}
			]
		});

		expect(mocks.invoke).toHaveBeenCalledWith('fs_write_xlsx', expect.any(Object));
		expect(out.result).toMatch(/Wrote: fib\.xlsx/);
	});

	it('rejects a row that crammed multi-row data into one row (cell count blowout)', async () => {
		// 2-column header, then a single data row with 200 cells —
		// the model trying to fit a 50-record table in one row.
		const wide = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? String(i + 1) : ''));
		const out = await callXlsx({
			path: 'out.xlsx',
			sheets: [{ name: 'S', rows: [['n', 'F(n)'], wide] }]
		});
		expect(JSON.parse(out.result).error).toMatch(/cells but the header has/i);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('rejects a sheet where a named column is entirely blank in every data row', async () => {
		// Header has "n" and "F(n)" but F(n) is empty on every row —
		// a scaffold waiting to be filled in.
		const rows: string[][] = [['n', 'F(n)']];
		for (let i = 1; i <= 50; i++) rows.push([String(i), '']);
		const out = await callXlsx({
			path: 'out.xlsx',
			sheets: [{ name: 'S', rows }]
		});
		expect(JSON.parse(out.result).error).toMatch(/"F\(n\)" is entirely blank/i);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('allows blank cells in some rows of a column as long as some have data', async () => {
		mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
		const out = await callXlsx({
			path: 'sparse.xlsx',
			sheets: [
				{
					name: 'S',
					rows: [
						['Name', 'Note'],
						['Alice', 'first'],
						['Bob', ''],
						['Carol', 'third']
					]
				}
			]
		});
		expect(out.result).toMatch(/Wrote/);
	});

	it('accepts numeric and boolean cells and coerces them to strings for Rust', async () => {
		mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
		const out = await callXlsx({
			path: 'nums.xlsx',
			sheets: [
				{
					name: 'S',
					rows: [
						['N', 'F(N)', 'Flag'],
						[1, 0, true],
						[2, 1, false]
					]
				}
			]
		});
		expect(out.result).toMatch(/Wrote/);
		const payload = mocks.invoke.mock.calls.find((c) => c[0] === 'fs_write_xlsx')?.[1] as {
			sheets: { rows: unknown[][] }[];
		};
		expect(payload.sheets[0].rows).toEqual([
			['N', 'F(N)', 'Flag'],
			['1', '0', 'true'],
			['2', '1', 'false']
		]);
	});

	it('does not flag a column of numeric zeros as entirely blank', async () => {
		mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
		const out = await callXlsx({
			path: 'zeros.xlsx',
			sheets: [
				{
					name: 'S',
					rows: [
						['Name', 'Count'],
						['alpha', 0],
						['beta', 0]
					]
				}
			]
		});
		expect(out.result).toMatch(/Wrote/);
	});

	it('coerces null cells to empty strings (still blank for validation)', async () => {
		const rows = [
			['n', 'F(n)'],
			[1, null],
			[2, null]
		];
		const out = await callXlsx({ path: 'out.xlsx', sheets: [{ name: 'S', rows }] });
		expect(JSON.parse(out.result).error).toMatch(/"F\(n\)" is entirely blank/i);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('accepts formulas (cells starting with "=")', async () => {
		mocks.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);

		const out = await callXlsx({
			path: 'formulas.xlsx',
			sheets: [
				{
					name: 'Calc',
					rows: [
						['A', 'B', 'Sum'],
						['1', '2', '=A2+B2']
					]
				}
			]
		});

		expect(mocks.invoke).toHaveBeenCalledWith('fs_write_xlsx', expect.any(Object));
		expect(out.result).toMatch(/Wrote/);
	});
});
