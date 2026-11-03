/**
 * Where each spec entry stands in a 3D models run. The creation stage fills
 * these in, the review changes them, and animation and the report read them.
 */

import type { ModelSpec } from '#lib/models3d/spec/types.ts';

export type EntryStatus = 'pending' | 'done' | 'needs_work' | 'skipped';

/** How an entry's clips went, once the animation stage has run on it. */
export interface ClipsState {
	status: 'pending' | 'done' | 'needs_work';
	/** What kept the clips from done at their last check. */
	problems: string[];
	rounds: number;
	/** The clips whose motion sheet was written. */
	sheets: string[];
}

export interface EntryState {
	id: string;
	status: EntryStatus;
	/** What kept it from done at its last check; empty when done. */
	problems: string[];
	/** Turns spent on it in the current build (the review's rebuild counts afresh). */
	rounds: number;
	/** The user's rebuild note from the review, or null. */
	note: string | null;
	/** The last render sheet, as a data URL, or null when nothing built. */
	sheet: string | null;
	/** Whether `<id>.glb` was written by this run. */
	glb: boolean;
	/** What the last check reported that doesn't block. */
	warnings: string[];
	/** The animation stage's result; null when it did not animate this entry. */
	clips: ClipsState | null;
}

/** One pending state per entry, in spec order. */
export function initialEntryStates(spec: ModelSpec): EntryState[] {
	return spec.entries.map((e) => ({
		id: e.id,
		status: 'pending',
		problems: [],
		rounds: 0,
		note: null,
		sheet: null,
		glb: false,
		warnings: [],
		clips: null
	}));
}
