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
