/**
 * Normalize an unknown caught value to a human-readable message.
 * Replaces the `e instanceof Error ? e.message : String(e)` idiom that was
 * repeated throughout the codebase.
 */
export function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
