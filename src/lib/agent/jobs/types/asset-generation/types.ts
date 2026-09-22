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
	seed: number;
	durationMs: number;
	/** Coherence layers this entry had to do without, in plain words. */
	degraded: string[];
	reason?: string;
}
