/**
 * Normalize an unknown caught value to a human-readable message.
 * Replaces the `e instanceof Error ? e.message : String(e)` idiom that was
 * repeated throughout the codebase.
 */
export function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * True when a caught value is the DOMException fetch/AbortController throws
 * on cancellation. Replaces the `e instanceof DOMException && e.name ===
 * 'AbortError'` test that was repeated across the agent tools, stores, and
 * job runner.
 */
export function isAbortError(e: unknown): boolean {
	return e instanceof DOMException && e.name === 'AbortError';
}

/**
 * Classify a caught value as user cancellation vs real failure and produce
 * the message to surface. Shared by the job runner's catch blocks.
 */
export function normalizeAbort(e: unknown): { aborted: boolean; msg: string } {
	const aborted = isAbortError(e);
	return { aborted, msg: aborted ? 'Cancelled by user' : errMessage(e) };
}
