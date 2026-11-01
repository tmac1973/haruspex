/**
 * A seed for a generation that pinned none: a non-negative 32-bit integer,
 * which every image, music and video engine here accepts.
 *
 * Resolved by the caller rather than left to the engine or template: a
 * template's own default is a constant, so every unpinned request would run at
 * the same seed, a retry would repeat the attempt it was retrying, and the
 * result's seed would be a value nobody chose (or, from an OpenAI-style
 * answer, not reported at all).
 */
export function randomSeed(): number {
	return Math.floor(Math.random() * 2 ** 31);
}

/** The largest seed every engine here takes (acestep.cpp's Philox noise is the tightest). */
export const MAX_SEED = 2 ** 32 - 1;

/** A tool's `seed` argument: undefined for none, the seed, or what is wrong with it. */
export function parseSeed(raw: unknown): number | undefined | string {
	if (raw === undefined || raw === null || raw === '') return undefined;
	const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_SEED) {
		return `seed must be a whole number from 0 to ${MAX_SEED}.`;
	}
	return n;
}
