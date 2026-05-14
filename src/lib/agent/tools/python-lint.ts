import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '$lib/debug-log';

interface RuffLocation {
	row: number;
	column: number;
}

interface RuffDiagnostic {
	code: string | null;
	message: string;
	location: RuffLocation;
}

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

	let raw: string;
	try {
		raw = await invoke<string>('fs_lint_python', { workdir, relPath });
	} catch (e) {
		logDebug('lint', 'fs_lint_python invocation failed', { relPath, error: String(e) });
		return '';
	}

	let diags: RuffDiagnostic[];
	try {
		diags = JSON.parse(raw) as RuffDiagnostic[];
	} catch {
		logDebug('lint', 'ruff output was not valid JSON', { rawPreview: raw.slice(0, 200) });
		return '';
	}

	if (!Array.isArray(diags) || diags.length === 0) return '';

	const shown = diags.slice(0, MAX_DIAGS);
	const lines = shown.map((d) => {
		const code = d.code ?? '?';
		const row = d.location?.row ?? 0;
		const col = d.location?.column ?? 0;
		return `${code} [${row}:${col}] ${d.message}`;
	});
	const more = diags.length > MAX_DIAGS ? `\n... ${diags.length - MAX_DIAGS} more` : '';

	return (
		`\n\n<diagnostics file="${relPath}">\n` +
		`Lint errors detected — please fix:\n` +
		`${lines.join('\n')}${more}\n` +
		`</diagnostics>`
	);
}
