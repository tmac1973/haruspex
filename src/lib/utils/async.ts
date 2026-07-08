/**
 * Async timing helpers shared across the app.
 */

/** Resolve after `ms` milliseconds. Replaces the inline
 * `new Promise((r) => setTimeout(r, ms))` idiom. */
export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
