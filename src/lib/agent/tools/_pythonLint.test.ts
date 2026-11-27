import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

vi.mock('#lib/debugLog.ts', async (importOriginal) =>
	(await import('#lib/testing/debugLog.ts')).mockDebugLog(importOriginal)
);

import { lintPythonIfApplicable } from './_pythonLint';

const diag = (code: string, message: string, line: number, column: number) => ({
	code,
	message,
	line,
	column,
	endLine: line,
	endColumn: column + 1,
	url: null
});

describe('lintPythonIfApplicable', () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it('returns empty for non-python paths without invoking ruff', async () => {
		const out = await lintPythonIfApplicable('/work', 'notes.md');
		expect(out).toBe('');
		expect(invoke).not.toHaveBeenCalled();
	});

	it('returns empty when working directory is null', async () => {
		const out = await lintPythonIfApplicable(null, 'foo.py');
		expect(out).toBe('');
		expect(invoke).not.toHaveBeenCalled();
	});

	it('formats ruff diagnostics into a <diagnostics> block', async () => {
		vi.mocked(invoke).mockResolvedValueOnce([
			diag('F821', 'Undefined name `requets`', 12, 5),
			diag('F401', '`os` imported but unused', 3, 1)
		]);
		const out = await lintPythonIfApplicable('/work', 'analyzer.py');
		expect(out).toContain('<diagnostics file="analyzer.py">');
		expect(out).toContain('F821 [12:5] Undefined name `requets`');
		expect(out).toContain('F401 [3:1] `os` imported but unused');
		expect(out).toContain('</diagnostics>');
	});

	it('returns empty string when ruff reports no diagnostics', async () => {
		vi.mocked(invoke).mockResolvedValueOnce([]);
		const out = await lintPythonIfApplicable('/work', 'clean.py');
		expect(out).toBe('');
	});

	it('caps output at 20 diagnostics and notes the overflow', async () => {
		const many = Array.from({ length: 25 }, (_, i) => diag('F401', `dup ${i}`, i + 1, 1));
		vi.mocked(invoke).mockResolvedValueOnce(many);
		const out = await lintPythonIfApplicable('/work', 'noisy.py');
		expect(out).toContain('... 5 more');
		expect((out.match(/F401/g) ?? []).length).toBe(20);
	});

	it('swallows invocation failures and returns empty', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('sidecar missing'));
		const out = await lintPythonIfApplicable('/work', 'foo.py');
		expect(out).toBe('');
	});

	it('treats uppercase .PY as Python too', async () => {
		vi.mocked(invoke).mockResolvedValueOnce([]);
		await lintPythonIfApplicable('/work', 'WEIRD.PY');
		expect(invoke).toHaveBeenCalled();
	});
});
