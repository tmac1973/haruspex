import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	listGlobals: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

vi.mock('./sandbox', () => ({
	listSandboxGlobals: mocks.listGlobals
}));

import { lintSandboxCode, formatLintFailure, type LintIssue } from './lint';

describe('lintSandboxCode', () => {
	beforeEach(() => {
		mocks.invoke.mockReset();
		mocks.listGlobals.mockReset();
		mocks.listGlobals.mockResolvedValue([]);
	});

	it('returns parsed diagnostics from ruff', async () => {
		mocks.invoke.mockResolvedValue([
			{
				code: 'F821',
				message: "Undefined name `df_cleand`",
				line: 4,
				column: 7,
				endLine: 4,
				endColumn: 16,
				url: 'https://docs.astral.sh/ruff/rules/undefined-name'
			}
		]);
		const out = await lintSandboxCode('print(df_cleand)');
		expect(out).toHaveLength(1);
		expect(out[0].code).toBe('F821');
		expect(out[0].line).toBe(4);
		expect(out[0].url).toBe('https://docs.astral.sh/ruff/rules/undefined-name');
	});

	it('passes the chat globals through as ruff builtins', async () => {
		mocks.listGlobals.mockResolvedValue(['df', 'pd']);
		mocks.invoke.mockResolvedValue([]);
		await lintSandboxCode('df.head()');
		expect(mocks.invoke).toHaveBeenCalledWith('lint_python_source', {
			code: 'df.head()',
			builtins: ['df', 'pd']
		});
	});

	it('returns [] when the Tauri call throws — lint is advisory', async () => {
		mocks.invoke.mockRejectedValue(new Error('ruff sidecar missing'));
		const out = await lintSandboxCode('print("hi")');
		expect(out).toEqual([]);
	});

	it('normalizes null url to undefined', async () => {
		mocks.invoke.mockResolvedValue([
			{ code: 'F541', message: 'f-string', line: 1, column: 1, endLine: 1, endColumn: 5, url: null }
		]);
		const out = await lintSandboxCode('f""');
		expect(out[0].url).toBeUndefined();
	});
});

describe('formatLintFailure', () => {
	const issue = (code: string, line: number, message: string): LintIssue => ({
		code,
		message,
		line,
		column: 1,
		endLine: line,
		endColumn: 5
	});

	it('uses singular phrasing for one issue', () => {
		const out = formatLintFailure([issue('F821', 3, "Undefined name `x`")]);
		expect(out).toMatch(/caught 1 issue/);
		expect(out).toMatch(/line 3 \[F821\]: Undefined name `x`/);
	});

	it('uses plural phrasing for multiple issues', () => {
		const out = formatLintFailure([
			issue('F821', 1, 'a'),
			issue('F632', 2, 'b'),
			issue('B006', 3, 'c')
		]);
		expect(out).toMatch(/caught 3 issues/);
		expect(out).toMatch(/line 1 \[F821\]: a/);
		expect(out).toMatch(/line 2 \[F632\]: b/);
		expect(out).toMatch(/line 3 \[B006\]: c/);
	});

	it('explains the noqa escape hatch so the model can suppress false positives', () => {
		const out = formatLintFailure([issue('F821', 1, 'x')]);
		expect(out).toMatch(/# noqa: <CODE>/);
	});
});
