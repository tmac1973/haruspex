/**
 * Reading an `unknown` (a tool's arguments, a parsed settings blob, a spec) as
 * a string or a number. Callers differ on purpose in what they trim and what
 * stands for "absent" — '' or null, undefined or NaN — so each variant is
 * named for exactly what it does.
 */

/** A string as it is, or `fallback` for anything else. */
export function stringOr(v: unknown, fallback = ''): string {
	return typeof v === 'string' ? v : fallback;
}

/** A string trimmed, or '' for anything else. */
export function trimmed(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

/** A string trimmed, or null when it is blank or not a string. */
export function trimmedOrNull(v: unknown): string | null {
	return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** A non-empty string as it is (not trimmed), or null. */
export function nonEmptyOrNull(v: unknown): string | null {
	return typeof v === 'string' && v.length > 0 ? v : null;
}

/** A finite number, or null. Strings are not parsed. */
export function finiteOrNull(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A finite number, or undefined. Strings are not parsed. */
export function finiteOrUndefined(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A number or a non-blank numeric string, as a finite number; null otherwise. */
export function parsedFiniteOrNull(v: unknown): number | null {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
}

/**
 * A number as it is (NaN and Infinity too), or NaN for anything else. NaN
 * stands for "absent", so validation reports it rather than a quiet zero.
 */
export function numberOrNaN(v: unknown): number {
	return typeof v === 'number' ? v : NaN;
}

/**
 * A number as it is, or a string parsed with `Number` (so '' is 0) when that
 * is finite; NaN otherwise, as {@link numberOrNaN}.
 */
export function parsedOrNaN(v: unknown): number {
	if (typeof v === 'number') return v;
	const n = typeof v === 'string' ? Number(v) : NaN;
	return Number.isFinite(n) ? n : NaN;
}
