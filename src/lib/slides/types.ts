/**
 * A slide deck as `fs_write_slides` takes it, after `prepareSlides` has
 * normalized it. The .odp writer in Rust (`fs_tools/slides.rs`) reads only
 * `content` and `section` slides: `foldForOdp` turns the rest into those.
 */

/** The page shape: landscape is 16:9, portrait 9:16. */
export type SlideOrientation = 'landscape' | 'portrait';

export const SLIDE_LAYOUTS = [
	'cover',
	'section',
	'content',
	'two-column',
	'image',
	'quote',
	'stat'
] as const;

export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

/** A plain string is a top-level bullet; `level` nests it (0–2). */
export type SlideBullet = string | { text: string; level?: number };

export interface Slide {
	/** On a quote slide the quote, on a stat slide the number. */
	title: string;
	layout?: SlideLayout;
	/** A cover or section slide's tagline, a quote's speaker, a stat's meaning,
	 *  or the line under an image slide's title. */
	subtitle?: string;
	bullets?: SlideBullet[];
	/** A two-column slide's right column. */
	right?: SlideBullet[];
	/** A png, jpg or gif in the working directory. */
	image?: string;
	/** Speaker notes. */
	notes?: string;
}

/** A slide's picture, read and measured, ready to embed. */
export interface SlideImage {
	mime: 'image/png' | 'image/jpeg' | 'image/gif';
	bytes: Uint8Array;
	width: number;
	height: number;
}
