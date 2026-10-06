/**
 * The asset spec: the one file that is the contract between a human, guided
 * planning and the asset job.
 *
 * It lives in the user's project, not in Haruspex, and it is the thing that
 * makes a re-run reproducible — the entries, the style, the palette and the
 * anchor's provenance all travel together in version control.
 *
 * Asset-domain code, so it lives under `src/lib/assets/`. It may depend on
 * `src/lib/image/` (the backend layer); the reverse is forbidden and tested.
 */

import type { TextureRecipe } from '$lib/ipc/gen/TextureRecipe';
import type { LoraRef, SamplerSettings } from '$lib/image/types';
import type { NormalizeProfile } from '$lib/ipc/gen/NormalizeProfile';

export type { NormalizeProfile };

/** What kind of thing an entry is. Mirrors the Rust `AssetKind`. */
export type AssetKind = 'sprite' | 'texture' | 'icon';

export const ASSET_KINDS: readonly AssetKind[] = ['sprite', 'texture', 'icon'];

/**
 * Ids are safe as filenames and as content keys in the game that consumes
 * them — the same shape the dark_times content tree used.
 */
export const ID_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;

export interface AssetEntry {
	/** Assigned by the runner, never by the model. */
	id: string;
	kind: AssetKind;
	prompt: string;
	/** Output path, relative to the working directory. */
	out: string;
	/**
	 * Overrides the profile's `target_size` for this entry only. The
	 * generation edge is derived from it the same way, clamp included.
	 */
	size?: number;
	seamless?: boolean;
	/**
	 * Which sheet this entry is drawn on, with the others that share the name.
	 *
	 * A sheet renders its subjects at one scale and from one view, so it
	 * groups things that belong together — items with items, characters with
	 * characters. Sprites and icons only; a texture fills its own frame.
	 * Entries that name none are grouped by kind, in spec order.
	 */
	sheet?: string;
	/**
	 * Pins this entry's seed so one asset can be made reproducible. The
	 * quality gate's retries still vary it — a pinned seed that fails every
	 * check would otherwise retry identically forever.
	 */
	seed?: number | null;
	negativePrompt?: string;
	/**
	 * Documentation for whoever reads the file. Never read by code — stated
	 * so it is not mistaken for a knob nothing consumes.
	 */
	notes?: string;
	/**
	 * Set by a run when every attempt at this entry was rejected: why the last
	 * check failed. The file at `out` is then the best rejected attempt, kept
	 * so the code has something to load. Review assets offers it to be made
	 * again; the next accepted generation clears this.
	 */
	rejected?: string;
	/**
	 * Textures drawn by code: the recipe they are drawn from. Written by the
	 * run's recipe stage, kept so a re-run draws the same tiles, and editable
	 * by hand. Validated by Rust (`texture_validate`), not here.
	 */
	recipe?: TextureRecipe;
	/**
	 * Every tile file of a code-drawn texture, `out` first. Interchangeable:
	 * a map picks one per cell.
	 */
	variants?: string[];
}

/** Where the committed anchor lives, relative to the working directory. */
export interface AnchorRef {
	image: string;
	recipe: string;
	/**
	 * The sheet that serves as the style anchor, by its entries' `sheet` name.
	 * Chosen by the derivation turn for spread across the set's materials and
	 * colours. Unset means the first sheet of sprites.
	 */
	sheet?: string;
}

/**
 * Everything needed to explain why a later run stopped matching.
 *
 * Written beside the anchor image and committed with it. The fields come from
 * the request plus `ImageResult.meta`, which is why the backend echoes back
 * the sampler and LoRAs it actually resolved rather than leaving them on the
 * request — a recipe recording `sampler: undefined` explains nothing.
 */
export interface AnchorRecipe {
	version: 1;
	prompt: string;
	negativePrompt: string;
	seed: number;
	backend: string;
	model: string;
	sampler: SamplerSettings;
	loras: LoraRef[];
	size: number;
	palette: number[];
	createdAt: string;
	/** When the anchor is a sheet of real assets: which sheet, and its entries. */
	sheet?: string;
	entries?: string[];
}

export interface AssetStyle {
	/** Appended to every entry's prompt. One of the three coherence layers. */
	prompt: string;
	negativePrompt?: string;
	/**
	 * Pins the checkpoint for the whole set, so a re-run months later uses the
	 * same one. Unset means the configured default.
	 */
	model?: string;
	/**
	 * The ONLY source of LoRAs in this design. The generation loop degrades
	 * against the backend's `maxLoras`, and without a field here that
	 * degradation would have no input to degrade.
	 */
	loras?: LoraRef[];
}

export interface AssetSpec {
	version: 1;
	style: AssetStyle;
	anchor: AnchorRef;
	normalize: NormalizeProfile;
	entries: AssetEntry[];
	/**
	 * Top-level keys we did not recognise, kept so a user's own annotations
	 * survive a round trip through a job that rewrites the file.
	 */
	unknown?: Record<string, unknown>;
}

/**
 * The negative prompt for one entry: the entry's own, then the style's.
 *
 * Entry first because it is the more specific of the two, and joined rather
 * than replaced because both are real — the style says what the whole set
 * avoids and the entry says what this one does. The quality gate's retry
 * amendments are appended after both.
 */
export function joinNegativePrompts(entry?: string, style?: string): string {
	return [entry, style]
		.map((s) => (s ?? '').trim())
		.filter((s) => s.length > 0)
		.join(', ');
}
