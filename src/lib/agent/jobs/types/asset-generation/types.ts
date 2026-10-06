/**
 * What each stage hands the report.
 *
 * Structures, not prose. The report needs to say whether the anchor was reused
 * or generated and whether a human approved it, and scraping that back out of
 * a stage's human-readable output is how a report comes to say something the
 * run did not do.
 */

import type { TextureRecipe } from '$lib/ipc/gen/TextureRecipe';

/** How the run got its style anchor. */
export interface AnchorOutcome {
	source: 'reused' | 'generated';
	/** `auto` when an unattended run accepted the first one unseen. */
	approval: 'approved' | 'auto';
	/** Generations spent. 0 when reused. */
	attempts: number;
	/**
	 * Anchors thrown away because their palette had collapsed onto one hue.
	 *
	 * Recorded rather than silent: a run that needed four attempts to get a
	 * usable palette is telling you the style prompt describes a scene.
	 */
	rejected: number;
	paletteSize: number;
	/** Where the committed anchor lives, relative to the working directory. */
	imagePath: string;
	recipePath: string;
}

/** What happened to one asset. Filled in by the generation loop. */
export interface EntryOutcome {
	id: string;
	status: 'done' | 'skipped' | 'unresolved' | 'failed';
	attempts: number;
	/** The seed the backend resolved. Null when nothing was ever generated. */
	seed: number | null;
	durationMs: number;
	/** Coherence layers this entry had to do without, in plain words. */
	degraded: string[];
	reason?: string;
	/**
	 * Unresolved, but its best rejected attempt was written to `out` so there
	 * is something to load. The spec marks it `rejected` for review.
	 */
	kept?: boolean;
	/** Drawn by code from a recipe rather than by the image model. */
	codeDrawn?: boolean;
	/** A code-drawn texture's tile files, `out` first. */
	variants?: string[];
	/** The recipe, when the judge's no made the run revise it. */
	recipe?: TextureRecipe;
}

/**
 * One generation of one sheet. A sheet whose cells failed is generated again
 * with only those subjects, so one sheet can have several of these.
 */
export interface SheetOutcome {
	id: string;
	/** 1 for the first generation of this sheet, 2 for its first retry. */
	round: number;
	/** The entries asked for, in order. */
	subjects: string[];
	/** Every subject cut cleanly where it was asked for. */
	exact: boolean;
	/** The sheet came back opaque and its backdrop had to be keyed. */
	keyed: boolean;
	missing: number;
	merged: number;
	/** Cut, but rejected by the quality gate or the judge. */
	rejected: number;
	seed: number | null;
}
