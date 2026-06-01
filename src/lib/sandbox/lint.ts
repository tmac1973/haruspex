/**
 * Pre-run lint pass for the Python sandbox. Calls the Rust-side
 * `lint_python_source` Tauri command, which shells out to the ruff
 * sidecar with a curated rule set focused on bug-class issues the
 * model is likely to make:
 *
 *   - E9xx  syntax errors
 *   - F63x  comparison mistakes (is vs ==, etc.)
 *   - F7xx  control-flow misuse
 *   - F82x  undefined names / referenced-before-assignment (F821 is
 *           the headline win — catches typo'd variable names without
 *           running 40 lines of side-effect code first)
 *   - F541  f-string with no placeholders
 *   - F901  raise NotImplemented (vs NotImplementedError)
 *   - B006  mutable default argument
 *   - B008  function call in default argument
 *
 * Style rules (E2xx, W291, F401 unused-import, etc.) are deliberately
 * excluded — they add noise without catching real bugs. The model can
 * escape false positives with `# noqa: CODE` which ruff respects.
 *
 * Failures are silent (empty list returned) — lint is advisory and
 * must never block a run because ruff is missing or crashed.
 */

import { invoke } from '@tauri-apps/api/core';
import { listSandboxGlobals } from './sandbox';

export interface LintIssue {
	code: string;
	message: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	url?: string;
}

interface RawLintIssue {
	code: string;
	message: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	url?: string | null;
}

/**
 * Lint the snippet about to run in the sandbox. The active chat's persistent
 * Python globals are sent along as ruff `builtins` so F821 doesn't false-
 * positive on names defined by a prior `run_python` call.
 */
export async function lintSandboxCode(code: string): Promise<LintIssue[]> {
	try {
		const builtins = await listSandboxGlobals();
		const raw = await invoke<RawLintIssue[]>('lint_python_source', { code, builtins });
		return raw.map((d) => ({
			code: d.code,
			message: d.message,
			line: d.line,
			column: d.column,
			endLine: d.endLine,
			endColumn: d.endColumn,
			url: d.url ?? undefined
		}));
	} catch {
		return [];
	}
}

/**
 * Render a lint result as the string we return to the model. Keeps each
 * issue on a single line with code + line + message so a small model can
 * parse and act on it without context bloat.
 */
export function formatLintFailure(issues: LintIssue[]): string {
	const head =
		issues.length === 1
			? 'Lint failed before running (ruff caught 1 issue). No code was executed:'
			: `Lint failed before running (ruff caught ${issues.length} issues). No code was executed:`;
	const body = issues.map((i) => `  line ${i.line} [${i.code}]: ${i.message}`).join('\n');
	const tail =
		'\n\nFix the issues above and re-call run_python. ' +
		'If a diagnostic is a false positive, suppress it with `# noqa: <CODE>` at end of line.';
	return `${head}\n${body}${tail}`;
}
