/**
 * Clamp `value` into the integer range `[min, max]`, converting to an integer
 * with `round` (floor by default). Shared by the numeric Settings fields so the
 * `Math.max(min, Math.min(max, round(x)))` idiom isn't copy-pasted per setter.
 */
export function clampInt(
	value: number,
	min: number,
	max: number,
	round: (n: number) => number = Math.floor
): number {
	return Math.max(min, Math.min(max, round(value)));
}
