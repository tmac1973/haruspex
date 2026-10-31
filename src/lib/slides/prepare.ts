import { markdownImage, plainText } from '#lib/slides/markdown.ts';
import { SLIDE_THEMES } from '#lib/slides/themes.ts';
import type { SlideTheme } from '#lib/slides/themes.ts';
import { SLIDE_LAYOUTS } from '#lib/slides/types.ts';
import type { SlideOrientation } from '#lib/slides/types.ts';

/**
 * Shape fixes for a deck as a model sends it to `fs_write_slides`: what it
 * meant, in the shape the builders take. `prepareSlides` in fs-write.ts runs
 * these between its checks for scaffolds and markup.
 */

/** Bullet entries are plain strings or { text, level } objects. */
export function bulletText(b: unknown): string | undefined {
	if (typeof b === 'string') return b;
	if (b && typeof b === 'object' && 'text' in b) {
		const text = (b as { text: unknown }).text;
		if (typeof text === 'string') return text;
	}
	return undefined;
}

export function hasRealBullets(bullets: unknown): boolean {
	return (
		Array.isArray(bullets) &&
		bullets.some((b) => {
			const text = bulletText(b);
			return typeof text === 'string' && text.trim().length > 0;
		})
	);
}

const LAYOUT_NAMES = new Set<string>(SLIDE_LAYOUTS);

/** Other names a model gives the layouts. */
const LAYOUT_ALIASES: Record<string, string> = {
	title: 'cover',
	two_column: 'two-column',
	twocolumn: 'two-column',
	columns: 'two-column'
};

/**
 * Accept "Section" or "CONTENT" by lowercasing, and the aliases above.
 * Anything else ("timeline", 1) is dropped, so the slide gets the default
 * instead of failing the deck.
 */
function normalizeLayout(slide: Record<string, unknown>): void {
	const raw = typeof slide.layout === 'string' ? slide.layout.trim().toLowerCase() : '';
	const layout = LAYOUT_ALIASES[raw] ?? raw;
	if (LAYOUT_NAMES.has(layout)) slide.layout = layout;
	else delete slide.layout;
}

/** A non-empty string list is almost always one bullet per line. */
function splitLines(value: string): string[] {
	return value
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/** `list` without its Markdown picture bullets, and the first picture's path. */
function takeImages(list: unknown[]): { rest: unknown[]; image?: string } {
	let image: string | undefined;
	const rest = list.filter((b) => {
		const text = bulletText(b);
		const path = text === undefined ? undefined : markdownImage(text);
		if (path !== undefined) image ??= path;
		return path === undefined;
	});
	return { rest, image };
}

/**
 * A bullet that is a Markdown picture, `![alt](path)`, becomes the slide's
 * image when it has none (a slide shows one), and is dropped either way. A
 * picture in a column means a picture beside the bullets, so the columns
 * become one list on a content slide.
 */
function liftImageBullets(slide: Record<string, unknown>): void {
	const left = takeImages(Array.isArray(slide.bullets) ? slide.bullets : []);
	const right = takeImages(Array.isArray(slide.right) ? slide.right : []);
	const image = left.image ?? right.image;
	if (image === undefined) return;
	slide.image ??= image;
	if (slide.layout === 'two-column' || hasRealBullets(right.rest)) {
		slide.bullets = [...left.rest, ...right.rest];
		delete slide.right;
		slide.layout = 'content';
	} else {
		slide.bullets = left.rest;
	}
}

/** Titles and table cells are plain text: drop `**` markers there. */
function stripBoldMarkers(slide: Record<string, unknown>): void {
	for (const key of ['title', 'subtitle'] as const) {
		if (typeof slide[key] === 'string') slide[key] = plainText(slide[key]);
	}
	if (Array.isArray(slide.table)) {
		slide.table = slide.table.map((row: unknown) =>
			Array.isArray(row) ? row.map((c) => (typeof c === 'string' ? plainText(c) : c)) : row
		);
	}
}

/** Shape fixes that leave a slide's meaning alone, in place. */
export function normalizeSlide(slide: Record<string, unknown>): void {
	normalizeLayout(slide);
	// A blank `image` is the working folder itself, and a non-string one fails
	// the whole deck. Either way it means no image.
	if (typeof slide.image !== 'string' || slide.image.trim().length === 0) delete slide.image;
	if (typeof slide.bullets === 'string') slide.bullets = splitLines(slide.bullets);
	if (typeof slide.right === 'string') slide.right = splitLines(slide.right);
	if (slide.right !== undefined && !Array.isArray(slide.right)) delete slide.right;
	if (typeof slide.notes !== 'string' || slide.notes.trim().length === 0) delete slide.notes;
	liftImageBullets(slide);
	stripBoldMarkers(slide);
}

const hasColumns = (slide: Record<string, unknown>) =>
	hasRealBullets(slide.bullets) && hasRealBullets(slide.right);

/**
 * Two columns need both. With one, the slide is a content slide of that one;
 * with both and no layout, the model meant two columns. Only a two-column
 * slide keeps `right`.
 */
function settleColumns(slide: Record<string, unknown>): void {
	if (slide.layout === 'two-column' && !hasColumns(slide)) {
		delete slide.layout;
		if (!hasRealBullets(slide.bullets) && slide.right !== undefined) slide.bullets = slide.right;
	} else if (slide.layout === undefined && hasColumns(slide)) {
		slide.layout = 'two-column';
	}
	if (slide.layout !== 'two-column') delete slide.right;
}

/**
 * The layout a slide can actually be drawn with, in place: a chart or table
 * is drawn on a content slide, an image slide needs its image, a two-column
 * slide both columns (`settleColumns`), and a content slide with nothing in
 * it is a title on its own, so a section divider.
 */
export function settleLayout(slide: Record<string, unknown>): void {
	const hasData = slide.chart !== undefined || slide.table !== undefined;
	if (hasData) slide.layout = 'content';
	if (slide.layout === 'image' && slide.image === undefined) delete slide.layout;
	settleColumns(slide);
	const layout = slide.layout ?? 'content';
	if (
		layout === 'content' &&
		!hasData &&
		!hasRealBullets(slide.bullets) &&
		slide.image === undefined
	) {
		slide.layout = 'section';
	}
}

/** Portrait when the model asks for it by either name; landscape otherwise,
 *  as before the choice existed. */
export function normalizeOrientation(raw: unknown): SlideOrientation {
	const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	return value === 'portrait' || value === 'vertical' ? 'portrait' : 'landscape';
}

/** One of the themes, by name; light for anything else. */
export function normalizeTheme(raw: unknown): SlideTheme {
	const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	return (SLIDE_THEMES as readonly string[]).includes(value) ? (value as SlideTheme) : 'light';
}
