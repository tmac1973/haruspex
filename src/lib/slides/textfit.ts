import type { Box } from '#lib/slides/geometry.ts';

/**
 * Whether text fits its box, estimated before the deck is built. Nothing
 * here measures a real font: a character is taken to be about half its size
 * wide, which runs a little wide for the themes' fonts, so text is shrunk a
 * little early rather than late. Text that still needs well over its box at
 * the smallest step is refused, so the model splits the slide instead of
 * handing the user one that spills.
 */

/** Average character width, as a fraction of the font size. */
const CHAR_EM = 0.52;
/** Line height, as a multiple of the font size. */
const LINE = 1.2;
/** PptxGenJS's text inset, each side. */
const INSET = 0.1;

/** Scales tried in turn until the text fits. */
export const SHRINK_STEPS = [1, 0.9, 0.8, 0.7];

/** How far over its box text may be at the smallest step before it is
 *  refused. Below this, PowerPoint's and LibreOffice's own shrink-on-overflow
 *  take up the rest. */
export const OVERFLOW_LIMIT = 1.25;

export interface Paragraph {
	text: string;
	/** Font size in points, before scaling. */
	pt: number;
	/** How far the text starts in from the box's left edge, in inches. */
	indent: number;
}

/** How many lines `text` wraps to at `pt` points in `width` inches. */
export function wrappedLines(text: string, pt: number, width: number): number {
	const perLine = Math.max(1, Math.floor((width * 72) / (pt * CHAR_EM)));
	let lines = 1;
	let used = 0;
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const len = Math.min(word.length, perLine);
		if (used === 0) used = len;
		else if (used + 1 + len <= perLine) used += 1 + len;
		else {
			lines += 1;
			used = len;
		}
	}
	return lines;
}

/** The height paragraphs take at `scale`, in inches. */
export function textHeight(
	paras: Paragraph[],
	width: number,
	scale = 1,
	spaceBeforePt = 0
): number {
	let points = 0;
	paras.forEach((p, i) => {
		const pt = p.pt * scale;
		points += wrappedLines(p.text, pt, width - 2 * INSET - p.indent) * pt * LINE;
		if (i > 0) points += spaceBeforePt * scale;
	});
	return points / 72 + 2 * INSET;
}

/**
 * The first step at which something `height(scale)` inches tall fits in
 * `room` inches, and how full the room is there (`ratio` over 1 means it
 * still doesn't fit at the smallest step).
 */
export function fitHeight(
	height: (scale: number) => number,
	room: number
): { scale: number; ratio: number } {
	let ratio = Infinity;
	for (const scale of SHRINK_STEPS) {
		ratio = height(scale) / room;
		if (ratio <= 1) return { scale, ratio };
	}
	return { scale: SHRINK_STEPS[SHRINK_STEPS.length - 1], ratio };
}

/** The first step at which the paragraphs fit `box` (see `fitHeight`). */
export function fitScale(
	paras: Paragraph[],
	box: Box,
	spaceBeforePt = 0
): { scale: number; ratio: number } {
	return fitHeight((scale) => textHeight(paras, box.w, scale, spaceBeforePt), box.h);
}

/** Text that won't fit, found while a deck was built. Its message is the
 *  whole list, for the model to act on. */
export class DeckFitError extends Error {
	constructor(readonly problems: string[]) {
		super(
			`The deck was not written: ${problems.join(' ')} Split crowded slides into two, ` +
				`or cut words, then write the whole deck again.`
		);
	}
}
