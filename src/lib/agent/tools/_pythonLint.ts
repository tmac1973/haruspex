import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '#lib/debugLog.ts';
import type { LintDiagnostic } from '#lib/ipc/gen/LintDiagnostic.ts';
import { errMessage } from '#lib/utils/error.ts';

const MAX_DIAGS = 20;

/**
 * If `relPath` is a Python file, run ruff against it via the `fs_lint_python`
 * Tauri command and return a `<diagnostics>` block to append to the tool
 * result. Returns an empty string for non-Python files, no findings, or any
 * failure — the diagnostics path is best-effort and must never block a
 * successful write.
 */
export async function lintPythonIfApplicable(
	workdir: string | null,
	relPath: string
): Promise<string> {
	if (!workdir || !relPath.toLowerCase().endsWith('.py')) return '';

	let diags: LintDiagnostic[];
	try {
		diags = await invoke<LintDiagnostic[]>('fs_lint_python', { workdir, relPath });
	} catch (e) {
		logDebug('lint', 'fs_lint_python invocation failed', { relPath, error: errMessage(e) });
		return '';
	}

	if (!Array.isArray(diags) || diags.length === 0) return '';

	const shown = diags.slice(0, MAX_DIAGS);
	const lines = shown.map((d) => `${d.code} [${d.line}:${d.column}] ${d.message}`);
	const more = diags.length > MAX_DIAGS ? `\n... ${diags.length - MAX_DIAGS} more` : '';

	return (
		`\n\n<diagnostics file="${relPath}">\n` +
		`Lint errors detected — please fix:\n` +
		`${lines.join('\n')}${more}\n` +
		`</diagnostics>`
	);
}
