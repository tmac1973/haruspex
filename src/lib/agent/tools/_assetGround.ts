/**
 * A texture measured against the sprites that will stand on it, for
 * `make_asset`'s `sprites` argument: the same check the asset job runs on its
 * ground (`image_gen/ground.rs`, `asset-generation/ground.ts`), so a set made
 * a few calls at a time gets ground its sprites show up on too.
 */

import { groundContrast, groundPreview } from '#lib/assets/texture.ts';
import type { GroundContrast } from '#lib/ipc/gen/GroundContrast.ts';
import { errMessage } from '#lib/utils/error.ts';
import { resolveShellPath } from '#lib/agent/tools/_helpers.ts';
import type { Target } from '#lib/agent/tools/_assetIo.ts';

/** Most sprite files one call may name. */
export const MAX_SPRITES = 8;

/** The `sprites` argument: file paths, or what is wrong with it. */
export function spritesArg(raw: unknown): string[] | string {
	if (raw === undefined || raw === null) return [];
	const list = Array.isArray(raw) ? raw : [raw];
	const paths = list.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
	if (paths.length !== list.length) return '"sprites" is a list of sprite file paths.';
	if (paths.length > MAX_SPRITES) return `"sprites" takes at most ${MAX_SPRITES} files.`;
	return paths.map((p) => p.trim());
}

export interface GroundCheck {
	/** The tile laid 3×3 with up to three of the sprites on it. */
	preview: Uint8Array;
	/** What to tell the model: they show up, or why they wouldn't. */
	note: string;
}

/** Read the sprites and measure `tile` against them; a refusal string on a bad file. */
export async function checkGround(
	tile: Uint8Array,
	size: number,
	sprites: string[],
	target: Target
): Promise<GroundCheck | string> {
	const images: Uint8Array[] = [];
	for (const p of sprites) {
		try {
			images.push(new Uint8Array(await target.io.read(resolveShellPath(p, target.cwd))));
		} catch (e) {
			return `Could not read the sprite ${p}: ${errMessage(e)}`;
		}
	}
	const contrast = await groundContrast(tile, images);
	const preview = await groundPreview(tile, size, images);
	if (!contrast) return { preview, note: 'The sprites have no opaque pixels to measure.' };
	return { preview, note: groundNote(contrast, sprites) };
}

/** The lightness gap the check asks for (`ground.rs` MIN_GAP), as the advice states it. */
const GAP = 0.1;

/** sRGB grey of OKLab lightness `l`, as #rrggbb: the value to aim a ramp at. */
export function greyOf(l: number): string {
	const lin = Math.min(1, Math.max(0, l)) ** 3;
	const c = lin <= 0.0031308 ? 12.92 * lin : 1.055 * lin ** (1 / 2.4) - 0.055;
	const v = Math.round(c * 255)
		.toString(16)
		.padStart(2, '0');
	return `#${v}${v}${v}`;
}

/**
 * What to tell the model. Every sprite named here is one the user means to
 * stand on this ground, so one that blends is reported even when most show
 * up: the asset job's rule (more than half) is for a sample of a whole set.
 */
export function groundNote(c: GroundContrast, paths: string[]): string {
	const ground = c.ground.toFixed(2);
	// Rust skips a sprite with no opaque pixels, so the lists only line up
	// when none was skipped.
	const named = c.sprites.length === paths.length;
	const lost = named ? paths.filter((_, i) => c.blends[i]) : [];
	if (c.blending === 0) {
		return (
			`The sprites show up on it: its lightness is ${ground}, ` +
			`theirs ${c.sprites.map((l) => l.toFixed(2)).join(', ')}.`
		);
	}
	const which = named
		? lost.map((p) => `${p} (${c.sprites[paths.indexOf(p)].toFixed(2)})`).join(', ')
		: `${c.blending} of the sprites`;
	const lo = Math.min(...c.sprites) - GAP;
	const hi = Math.max(...c.sprites) + GAP;
	const ways = [
		...(hi <= 0.95 ? [`lighter than ${hi.toFixed(2)} (about ${greyOf(hi + 0.05)} in value)`] : []),
		...(lo >= 0.05 ? [`darker than ${lo.toFixed(2)} (about ${greyOf(lo - 0.05)})`] : [])
	];
	return (
		`These would be hard to see on it: ${which}, against the tile's ${ground} ` +
		`(lightness, 0 black to 1 white). Make the base ramp ` +
		`${ways.length ? ways.join(', or ') : 'clearly lighter or darker than them'}, ` +
		`keeping the material's own hue, and draw it again with overwrite: true.`
	);
}
