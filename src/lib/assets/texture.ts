/**
 * Textures drawn by code from a recipe (`src-tauri/src/image_gen/texture/`):
 * the asset job's recipe stage and `make_asset` both draw through here.
 */

import { invoke } from '@tauri-apps/api/core';
import type { TextureRecipe } from '#lib/ipc/gen/TextureRecipe.ts';
import { contactSheet } from '#lib/assets/normalize.ts';
import { errMessage } from '#lib/utils/error.ts';

/** Null when Rust would draw the recipe, else what is wrong with it. */
export async function validateRecipe(recipe: unknown): Promise<string | null> {
	try {
		await invoke('texture_validate', { recipe });
		return null;
	} catch (e) {
		return errMessage(e);
	}
}

/**
 * Draw a recipe's tiles: PNG bytes, base first. `palette` is packed
 * `0xRRGGBBAA`; empty keeps the recipe's own colours.
 */
export async function renderTexture(
	recipe: TextureRecipe,
	size: number,
	seed: number,
	variants: number,
	palette: number[]
): Promise<Uint8Array[]> {
	const tiles = await invoke<number[][]>('texture_render', {
		recipe,
		size,
		seed,
		variants,
		palette
	});
	return tiles.map((t) => new Uint8Array(t));
}

/** Every tile file of a texture with `n` variants: `out` first, then `<stem>_k`. */
export function variantPaths(out: string, n: number): string[] {
	const slash = out.lastIndexOf('/');
	const dot = out.lastIndexOf('.');
	const [stem, ext] = dot > slash ? [out.slice(0, dot), out.slice(dot)] : [out, ''];
	return [out, ...Array.from({ length: Math.max(0, n - 1) }, (_, i) => `${stem}_${i + 1}${ext}`)];
}

/** Most tiles one texture may have, as the renderer allows. */
export const MAX_VARIANTS = 8;

/**
 * The files a `make_asset` texture call writes, from its raw arguments: the
 * path, then one per extra variant.
 */
export function textureFiles(path: string, variants: unknown): string[] {
	const n =
		typeof variants === 'number' && variants >= 1
			? Math.min(MAX_VARIANTS, Math.round(variants))
			: 1;
	return variantPaths(path, n);
}

/** How wide a tiled preview aims to be, in pixels. */
const PREVIEW_EDGE = 480;

/**
 * One tile laid 3×3, the way a map lays it, scaled up by a whole number so
 * the pixels stay sharp. One tile alone cannot show what repeats: a lane line
 * in every copy, or a stain at the same spot in each.
 */
export function tiledPreview(tile: Uint8Array, size: number): Promise<Uint8Array> {
	const scale = Math.max(1, Math.floor(PREVIEW_EDGE / 3 / size));
	return contactSheet(Array(9).fill(tile), size * scale);
}

/** A 32-bit seed from text (FNV-1a), so the same name draws the same tiles. */
export function seedOf(text: string): number {
	let h = 0x811c9dc5;
	for (const ch of text) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}
