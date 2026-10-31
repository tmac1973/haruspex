import type { SlideOrientation } from '#lib/slides/types.ts';

/** The deck's type scale: every text size a layout uses, by orientation.
 *  Portrait's are larger: a portrait deck is read on a phone, its whole
 *  page a few inches wide, so a slide holds fewer, bigger words. */

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
		bullets: [26, 23, 20],
		title: 34,
		cover: 46,
		section: 40,
		tagline: 24,
		quote: 32,
		quoteMark: 110,
		speaker: 18,
		stat: 104,
		meaning: 28,
		imageTitle: 34,
		imageSubtitle: 22
	}
};
