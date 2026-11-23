/**
 * The Video sequence spec: one long video as plain data, written by the
 * model through a forced tool call and kept at `<episode>/sequence.json`.
 * Every stage of the job reads it; nothing in it depends on the run.
 *
 * Keys are snake_case, as the model writes them and the file keeps them.
 */
import type { Fit } from '#lib/ipc/gen/Fit.ts';

export const SPEC_VERSION = 1;

/** The default for `reanchor_every`: an end picture every this many clips. */
export const DEFAULT_REANCHOR = 6;

export interface SequenceSpec {
	version: 1;
	title: string;
	/** One line every prompt and keyframe gets: subject, look, light. */
	style: string;
	/** A Settings → Video editing format, when the spec wants one. */
	preset?: string;
	sections: Section[];
	/** One per gap between sections: `sections.length - 1`. */
	joins: Join[];
	sound: Sound;
	/**
	 * Every this-many clips of a section end on a re-anchor picture of the
	 * section, so a long run doesn't drift; 0 turns it off.
	 */
	reanchor_every: number;
}

/** A stretch made by the video model. */
export interface GeneratedSection {
	kind: 'generated';
	id: string;
	prompt: string;
	seconds: number;
	/** A picture in the episode folder to start from, given by the user. */
	start_image?: string;
	/** What the keyframe still shows, when it should differ from the prompt. */
	keyframe_prompt?: string;
	negative_prompt?: string;
	seed?: number;
}

/** A clip from the episode folder, used as it is. */
export interface ExistingSection {
	kind: 'existing';
	id: string;
	path: string;
	in_secs?: number;
	out_secs?: number;
	fit?: Fit;
}

export type Section = GeneratedSection | ExistingSection;

export interface Join {
	/** A hard cut, a crossfade, or a generated clip from A's end to B's start. */
	kind: 'cut' | 'crossfade' | 'transition';
	/** A crossfade's length; a transition's, when shorter than the model's longest clip. */
	secs?: number;
	/** What happens in a transition clip. */
	prompt?: string;
}

export interface Sound {
	/** Keep the sound the video model made with each clip. */
	clip_sound: boolean;
	music: MusicBed[];
	narration: Narration[];
}

/** One song under a run of sections. */
export interface MusicBed {
	/** A short slug, unique in the spec: its file is named after it. */
	id: string;
	sections: string[];
	/** What the music sounds like, as the music model takes it. */
	caption: string;
	/** How loud it sits; default -30 under speech, -14 alone. */
	lufs?: number;
}

/** A line spoken over a section. */
export interface Narration {
	section: string;
	/** Seconds into the section. */
	at_secs: number;
	text: string;
	/** A saved voice; the default voice when none. */
	voice?: string;
}
