import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

vi.mock('#lib/debugLog.ts', async (importOriginal) =>
	(await import('#lib/testing/debugLog.ts')).mockDebugLog(importOriginal)
);

import { lintPythonIfApplicable } from './_pythonLint';

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
		vi.mocked(invoke).mockResolvedValueOnce(
			JSON.stringify([
				{
					code: 'F821',
					message: 'Undefined name `requets`',
					location: { row: 12, column: 5 }
				},
				{
					code: 'F401',
					message: '`os` imported but unused',
					location: { row: 3, column: 1 }
				}
			])
		);
		const out = await lintPythonIfApplicable('/work', 'analyzer.py');
		expect(out).toContain('<diagnostics file="analyzer.py">');
		expect(out).toContain('F821 [12:5] Undefined name `requets`');
		expect(out).toContain('F401 [3:1] `os` imported but unused');
		expect(out).toContain('</diagnostics>');
	});

	it('returns empty string when ruff reports no diagnostics', async () => {
		vi.mocked(invoke).mockResolvedValueOnce('[]');
		const out = await lintPythonIfApplicable('/work', 'clean.py');
		expect(out).toBe('');
	});

	it('caps output at 20 diagnostics and notes the overflow', async () => {
		const many = Array.from({ length: 25 }, (_, i) => ({
			code: 'F401',
			message: `dup ${i}`,
			location: { row: i + 1, column: 1 }
		}));
		vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(many));
		const out = await lintPythonIfApplicable('/work', 'noisy.py');
		expect(out).toContain('... 5 more');
		expect((out.match(/F401/g) ?? []).length).toBe(20);
	});

	it('swallows invocation failures and returns empty', async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error('sidecar missing'));
		const out = await lintPythonIfApplicable('/work', 'foo.py');
		expect(out).toBe('');
	});

	it('swallows malformed JSON from ruff and returns empty', async () => {
		vi.mocked(invoke).mockResolvedValueOnce('not json');
		const out = await lintPythonIfApplicable('/work', 'foo.py');
		expect(out).toBe('');
	});

	it('treats uppercase .PY as Python too', async () => {
		vi.mocked(invoke).mockResolvedValueOnce('[]');
		await lintPythonIfApplicable('/work', 'WEIRD.PY');
		expect(invoke).toHaveBeenCalled();
	});
});
