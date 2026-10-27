/**
 * A texture measured against the sprites that will stand on it, for
 * `make_asset`'s `sprites` argument: the same check the asset job runs on its
 * ground (`image_gen/ground.rs`, `asset-generation/ground.ts`), so a set made
 * a few calls at a time gets ground its sprites show up on too.
 */

import { blendReason } from '#lib/agent/jobs/types/asset-generation/ground.ts';
import { groundContrast, groundPreview } from '#lib/assets/texture.ts';
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
	const blends = blendReason(contrast);
	const note = blends
		? `${blends} Draw it again with overwrite: true.`
		: `The sprites show up on it: its lightness is ${contrast.ground.toFixed(2)}, ` +
			`theirs ${contrast.sprites.map((l) => l.toFixed(2)).join(', ')}.`;
	return { preview, note };
}
