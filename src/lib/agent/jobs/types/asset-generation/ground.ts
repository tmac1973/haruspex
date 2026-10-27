/**
 * The ground measured against the sprites that stand on it.
 *
 * The anchor's colours are the sprites'. Ground drawn in them is ground the
 * sprites vanish into: a dungeon run of near-black monsters got near-black
 * floors, at a lightness gap of 0.03. So the anchor's sprites are cut out once
 * and every code-drawn tile is measured against them (`image_gen/ground.rs`),
 * then shown to the judge with three of them stood on it.
 */

import { splitSheet } from '#lib/assets/normalize.ts';
import { groundContrast, spriteTone } from '#lib/assets/texture.ts';
import type { GroundContrast } from '#lib/ipc/gen/GroundContrast.ts';
import type { NormalizeProfile } from '#lib/ipc/gen/NormalizeProfile.ts';
import type { SpriteTone } from '#lib/ipc/gen/SpriteTone.ts';
import { hexOf } from '#lib/agent/jobs/types/asset-generation/prompts.ts';

/** Most sprites measured against each tile; the largest are kept. */
const MEASURED = 8;

/** A piece smaller than this share of the largest is a speck, not a sprite. */
const SPECK = 0.05;

export interface Ground {
	/** The anchor's sprites as PNG bytes, largest first. */
	sprites: Uint8Array[];
	tone: SpriteTone;
}

/**
 * The anchor's sprites and their tone; null when it has none to cut, such as
 * a set of textures alone, or when the cut fails. Without them the run draws
 * textures as before, unmeasured.
 */
export async function groundOf(
	anchor: Uint8Array,
	profile: NormalizeProfile
): Promise<Ground | null> {
	try {
		const split = await splitSheet(anchor, {
			alphaThreshold: profile.alpha_threshold ?? undefined,
			background: profile.background
		});
		const largest = Math.max(0, ...split.pieces.map((p) => p.area));
		const sprites = split.pieces
			.filter((p) => p.area >= largest * SPECK)
			.sort((a, b) => b.area - a.area)
			.slice(0, MEASURED)
			.map((p) => new Uint8Array(p.bytes));
		if (sprites.length === 0) return null;
		const tone = await spriteTone(sprites);
		return tone ? { sprites, tone } : null;
	} catch (e) {
		console.warn('Could not cut the anchor into sprites to measure the ground by', e);
		return null;
	}
}

/** Why the sprites would be hard to see on a tile, for the recipe writer; null when they show up. */
export function blendReason(c: GroundContrast): string | null {
	if (c.ok) return null;
	const way = c.tone.target > c.ground ? 'lighter' : 'darker';
	return (
		`The set's sprites would be hard to see on this tile: its lightness is ` +
		`${c.ground.toFixed(2)} (0 black, 1 white), and ${c.blending} of ${c.sprites.length} ` +
		`sprites are about as light (theirs: ${c.sprites.map((l) => l.toFixed(2)).join(', ')}). ` +
		`Make the base ramp clearly ${way}, around ${hexOf(c.tone.targetGrey)} in value, ` +
		`keeping the material's own hue.`
	);
}

/** The measured check for one tile: null when the sprites show up on it. */
export async function checkGround(tile: Uint8Array, ground: Ground): Promise<string | null> {
	const c = await groundContrast(tile, ground.sprites);
	return c ? blendReason(c) : null;
}
