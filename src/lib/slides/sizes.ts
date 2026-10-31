import type { SlideOrientation } from '#lib/slides/types.ts';

/** The deck's type scale: every text size a layout uses, by orientation.
 *  Portrait's are smaller, as its page is narrower. */

/** Font sizes in points, before any shrinking to fit. */
export interface Sizes {
	/** By nesting level. */
	bullets: number[];
	title: number;
	cover: number;
	section: number;
	/** A cover's or section's subtitle. */
	tagline: number;
	quote: number;
	quoteMark: number;
	speaker: number;
	stat: number;
	meaning: number;
	imageTitle: number;
	imageSubtitle: number;
}

export const SIZES: Record<SlideOrientation, Sizes> = {
	landscape: {
		bullets: [22, 19, 17],
		title: 34,
		cover: 48,
		section: 40,
		tagline: 22,
		quote: 30,
		quoteMark: 120,
		speaker: 18,
		stat: 110,
		meaning: 26,
		imageTitle: 36,
		imageSubtitle: 20
	},
	portrait: {
		bullets: [20, 18, 16],
		title: 30,
		cover: 40,
		section: 34,
		tagline: 20,
		quote: 26,
		quoteMark: 100,
		speaker: 16,
		stat: 96,
		meaning: 24,
		imageTitle: 30,
		imageSubtitle: 18
	}
};
