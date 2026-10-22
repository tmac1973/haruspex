/**
 * Textures drawn by code from a recipe (`src-tauri/src/image_gen/texture/`),
 * and the transition sets drawn from them: the asset job and `make_asset`
 * both draw through here.
 */

import { invoke } from '@tauri-apps/api/core';
import type { TextureRecipe } from '#lib/ipc/gen/TextureRecipe.ts';
import type { TransitionEdge } from '#lib/ipc/gen/TransitionEdge.ts';
import type { TransitionView } from '#lib/ipc/gen/TransitionView.ts';
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

/**
 * How a transition sheet is laid out: 16 tiles, 4 across, tile `i` at
 * column `i % 4`, row `⌊i / 4⌋`. Its bits are its corners — NW 1, NE 2,
 * SW 4, SE 8 — and a set bit is material A (top) or solid (side).
 */
export const TRANSITION_ORDER = 'NW=1 NE=2 SW=4 SE=8; a set bit is a/solid';

/** Null when Rust would draw with these edge settings, else what is wrong. */
export async function validateTransitionEdge(
	view: TransitionView,
	edge: unknown
): Promise<string | null> {
	try {
		await invoke('texture_transition_validate', { view, edge });
		return null;
	} catch (e) {
		return errMessage(e);
	}
}

/**
 * Draw a transition set: PNG bytes of the 4×4 sheet. `other` is material B
 * (top) or the cap (side). Each material takes the seed its texture was drawn
 * with, so the sheet's uniform tiles are that texture's tiles.
 */
export async function renderTransition(
	view: TransitionView,
	a: TextureRecipe,
	other: TextureRecipe | null,
	edge: TransitionEdge,
	size: number,
	seeds: { a: number; other: number },
	palette: number[]
): Promise<Uint8Array> {
	const bytes = await invoke<number[]>('texture_transition_render', {
		view,
		a,
		other,
		edge,
		size,
		seedA: seeds.a,
		seedOther: seeds.other,
		palette
	});
	return new Uint8Array(bytes);
}

/** A drawn set laid out as a small map, scaled up for looking at. */
export async function transitionPreview(
	view: TransitionView,
	sheet: Uint8Array,
	size: number
): Promise<Uint8Array> {
	const bytes = await invoke<number[]>('texture_transition_preview', {
		view,
		sheet: Array.from(sheet),
		size
	});
	return new Uint8Array(bytes);
}

/** One tile of a transition sheet, as its JSON map names it. */
export interface TransitionTile {
	index: number;
	x: number;
	y: number;
	corners: { nw: string; ne: string; sw: string; se: string };
}

/** The JSON written beside a transition sheet, for an engine to read it by. */
export interface TransitionMap {
	version: 1;
	view: TransitionView;
	tile_size: number;
	columns: 4;
	a: string;
	b?: string;
	cap?: string;
	order: string;
	tiles: TransitionTile[];
}

/**
 * The map of a sheet: each tile's place and corners, named. `other` is B's
 * name (top), or the cap's (side, optional); a side set's cleared corners
 * are "air".
 */
export function transitionMap(
	view: TransitionView,
	size: number,
	a: string,
	other?: string
): TransitionMap {
	const off = view === 'top' ? (other ?? 'b') : 'air';
	const name = (bit: number) => (bit ? a : off);
	return {
		version: 1,
		view,
		tile_size: size,
		columns: 4,
		a,
		...(view === 'top' ? { b: off } : other ? { cap: other } : {}),
		order: TRANSITION_ORDER,
		tiles: Array.from({ length: 16 }, (_, index) => ({
			index,
			x: (index % 4) * size,
			y: Math.floor(index / 4) * size,
			corners: {
				nw: name(index & 1),
				ne: name(index & 2),
				sw: name(index & 4),
				se: name(index & 8)
			}
		}))
	};
}
