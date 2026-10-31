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

export const CHART_TYPES = ['bar', 'line', 'pie', 'doughnut'] as const;

export type ChartType = (typeof CHART_TYPES)[number];

/** A chart drawn natively, so it stays editable in PowerPoint. Every series
 *  has one value per label; a pie or doughnut has one series. */
export interface SlideChart {
	type: ChartType;
	labels: string[];
	series: { name: string; values: number[] }[];
}

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
	/** A png, jpg or gif in the working directory. A content slide shows at
	 *  most one of `image`, `chart` and `table`. */
	image?: string;
	chart?: SlideChart;
	/** Rows of cells, the header first; every row as wide as the widest. */
	table?: string[][];
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
