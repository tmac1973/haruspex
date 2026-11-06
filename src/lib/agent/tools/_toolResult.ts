/**
 * Reading a tool's result string: did it fail? Kept free of imports so the
 * step UI can use it without loading the tools (see `_helpers.ts`, which
 * re-exports it).
 */

/**
 * Prefixes a fetch/research tool result uses to signal failure. The agent
 * loop (to skip recording a citation) and the chat store (to skip showing a
 * source chip) must agree on these, so the list lives in one place.
 */
export const FETCH_FAILURE_PREFIXES = [
	'Failed to fetch',
	'Research sub-agent failed',
	'Paywalled:'
] as const;

/** True when a tool result string is a known fetch/research failure. */
export function isFetchFailureResult(result: string | undefined): boolean {
	return !!result && FETCH_FAILURE_PREFIXES.some((p) => result.startsWith(p));
}

/**
 * True when a tool result string reports a failure, across every error
 * shape the tools emit: the `{"error": ...}` JSON envelope from
 * `toolError()`, the `Error:` prefix (sandbox runs, ad-hoc errors), lint
 * failures, and the fetch/research failure prefixes. The step UI uses
 * this to decide check-mark vs ✕ — keep it in sync when introducing a
 * new error shape (better: don't introduce new shapes).
 */
export function isToolErrorResult(result: string | undefined): boolean {
	if (!result) return false;
	const r = result.trimStart();
	return (
		r.startsWith('{"error"') ||
		r.startsWith('Error:') ||
		r.startsWith('Lint failed') ||
		isFetchFailureResult(r)
	);
}
