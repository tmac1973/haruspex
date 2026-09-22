/**
 * What each stage hands the report.
 *
 * Structures, not prose. The report needs to say whether the anchor was reused
 * or generated and whether a human approved it, and scraping that back out of
 * a stage's human-readable output is how a report comes to say something the
 * run did not do.
 */

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
}
