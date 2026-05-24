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
