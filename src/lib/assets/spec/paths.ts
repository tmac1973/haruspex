/**
 * Where the spec, the anchor and generated assets live, relative to the
 * working directory.
 *
 * One place, because every one of these is referenced from more than one
 * phase: the spec stage writes the anchor paths that the anchor stage reads,
 * and the derivation assigns output paths that validation then checks for
 * collisions. A convention written down twice is a convention that drifts.
 */

import type { AssetKind } from './types';

export const DEFAULT_SPEC_PATH = 'assets/haruspex-assets.json';
export const DEFAULT_ANCHOR_IMAGE = 'assets/haruspex-anchor.png';
export const DEFAULT_ANCHOR_RECIPE = 'assets/haruspex-anchor.json';

/** Where a derived entry's PNG goes. */
export function defaultOutPath(kind: AssetKind, id: string): string {
	return `assets/generated/${kind}/${id}.png`;
}

/**
 * Turn a title into an id: lowercase, runs of non-alphanumerics become one
 * `_`, trimmed, prefixed when it would not start with a letter, truncated to
 * fit [`ID_PATTERN`].
 *
 * The runner assigns ids rather than trusting the model with them, the same
 * way the coding job assigns item ids — a model that renames a thing halfway
 * through a list leaves the game referencing something that does not exist.
 */
export function slugify(title: string): string {
	const base = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	// A title with no alphanumerics at all leaves nothing to slugify, and
	// `a_` would technically pass the pattern while telling the reader nothing.
	if (base.length === 0) return 'asset';
	const prefixed = /^[a-z]/.test(base) ? base : `a_${base}`;
	return prefixed.slice(0, 48);
}

/**
 * `slugify`, made unique against ids already taken.
 *
 * Truncates far enough to leave room for the suffix, so a collision between
 * two 48-character titles cannot produce an id that fails the pattern.
 */
export function uniqueId(title: string, taken: Set<string>): string {
	const base = slugify(title);
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const suffix = `_${n}`;
		const id = `${base.slice(0, 48 - suffix.length)}${suffix}`;
		if (!taken.has(id)) return id;
	}
}
