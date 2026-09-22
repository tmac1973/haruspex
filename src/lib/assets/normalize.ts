/**
 * Thin wrappers over the Rust normalization commands.
 *
 * No logic here on purpose. The pipeline has one implementation and it is the
 * Rust one — a second copy in TypeScript is exactly how the thing that
 * normalizes and the thing that builds a request come to disagree about what a
 * texture is.
 *
 * Note the module. This is asset-domain code, so it lives under
 * `src/lib/assets/` rather than `src/lib/image/`, which is the backend layer
 * and whose layering test forbids the word.
 */

import { invoke } from '@tauri-apps/api/core';
import type { NormalizeProfile } from '$lib/ipc/gen/NormalizeProfile';
import type { NormalizeResult } from '$lib/ipc/gen/NormalizeResult';
import type { AssetKind } from '$lib/ipc/gen/AssetKind';
import type { CheckReport } from '$lib/ipc/gen/CheckReport';
import type { ImageStats } from '$lib/ipc/gen/ImageStats';
import type { PaletteSpread } from '$lib/ipc/gen/PaletteSpread';

export type {
	NormalizeProfile,
	NormalizeResult,
	AssetKind,
	CheckReport,
	ImageStats,
	PaletteSpread
};

/** Key, crop, downscale, quantize and outline one image. */
export function normalizeImage(
	bytes: Uint8Array,
	profile: NormalizeProfile,
	kind: AssetKind
): Promise<NormalizeResult> {
	return invoke<NormalizeResult>('image_normalize', {
		bytes: Array.from(bytes),
		profile,
		kind
	});
}

/**
 * The shipped default profile.
 *
 * Fetched rather than duplicated: every number in it was arrived at by
 * measuring real output, and a second copy in TypeScript would drift from
 * those measurements the day one of them changed.
 */
export function defaultProfile(): Promise<NormalizeProfile> {
	return invoke<NormalizeProfile>('image_default_profile');
}

/**
 * Judge one normalization's measurements against the profile's thresholds.
 *
 * Takes the stats `normalizeImage` returned rather than the image:
 * `palette_distance` is only knowable during quantization, so re-opening the
 * output would be measuring evidence that has already been destroyed.
 */
export function checkImage(
	stats: ImageStats,
	profile: NormalizeProfile,
	kind: AssetKind
): Promise<CheckReport> {
	return invoke<CheckReport>('image_check', { stats, profile, kind });
}

/** Tile a run's assets into one sheet — the artifact the set is judged on. */
export function contactSheet(images: Uint8Array[], cell: number): Promise<Uint8Array> {
	return invoke<number[]>('image_contact_sheet', {
		images: images.map((b) => Array.from(b)),
		cell
	}).then((b) => new Uint8Array(b));
}

/**
 * Whether a palette is spread out enough to be worth imposing on a set.
 *
 * The anchor's palette governs every asset, so one that has collapsed onto a
 * single hue does not make a set cohere — it makes every asset that colour.
 */
export function paletteSpread(palette: number[]): Promise<PaletteSpread> {
	return invoke<PaletteSpread>('image_palette_spread', { palette });
}

/** The shared palette, from the style anchor. */
export function extractPalette(
	bytes: Uint8Array,
	count: number,
	background?: NormalizeProfile['background']
): Promise<number[]> {
	return invoke<number[]>('image_extract_palette', {
		bytes: Array.from(bytes),
		count,
		background: background ?? null
	});
}

/**
 * Resolve a profile's per-kind overrides.
 *
 * Call this before building a request, so the reference strength and
 * background colour a generation uses come from the same resolver that will
 * normalize the result.
 */
export function effectiveProfile(
	profile: NormalizeProfile,
	kind: AssetKind
): Promise<NormalizeProfile> {
	return invoke<NormalizeProfile>('image_effective_profile', { profile, kind });
}
