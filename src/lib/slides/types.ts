/**
 * A slide deck as `fs_write_slides` takes it, after `prepareSlides` has
 * normalized it. The .odp writer in Rust (`fs_tools/slides.rs`) reads the
 * same shape, so a field added here is added there too.
 */

/** The page shape: landscape is 16:9, portrait 9:16. */
export type SlideOrientation = 'landscape' | 'portrait';

export type SlideLayout = 'content' | 'section';

/** A plain string is a top-level bullet; `level` nests it (0–2). */
export type SlideBullet = string | { text: string; level?: number };

export interface Slide {
	title: string;
	layout?: SlideLayout;
	/** Only a section slide shows it. */
	subtitle?: string;
	bullets?: SlideBullet[];
	/** A png, jpg or gif in the working directory. */
	image?: string;
}

/** A slide's picture, read and measured, ready to embed. */
export interface SlideImage {
	mime: 'image/png' | 'image/jpeg' | 'image/gif';
	bytes: Uint8Array;
	width: number;
	height: number;
}
