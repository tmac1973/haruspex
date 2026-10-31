import type { SlideOrientation } from '#lib/slides/types.ts';

/**
 * Where each part of a slide goes, in inches, for each orientation. The page
 * is 13.333 × 7.5 in landscape and turned on its side in portrait. Portrait
 * gives titles room for a second line, since the page is narrow, and stacks
 * what landscape puts side by side: an image above its bullets, the right
 * column under the left.
 */

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 16:9 on a 7.5in side: 40/3in, which PowerPoint's widescreen page is
 *  exactly. Rounded, a full-page picture stops short of the edge. */
export const LONG = 40 / 3;
export const SHORT = 7.5;
/** Between two blocks of a body: bullets and image, or two columns. */
const GAP = 0.5;
/** Kept clear at the foot of a content slide for its number. */
const FOOTER = 0.45;

export function pageSize(orientation: SlideOrientation): { w: number; h: number } {
	return orientation === 'portrait' ? { w: SHORT, h: LONG } : { w: LONG, h: SHORT };
}

function margin(orientation: SlideOrientation): number {
	return orientation === 'portrait' ? 0.5 : 0.6;
}

/** A content slide's title, full width at the top. */
export function titleBox(orientation: SlideOrientation): Box {
	const page = pageSize(orientation);
	const m = margin(orientation);
	return { x: m, y: m, w: page.w - 2 * m, h: orientation === 'portrait' ? 1.6 : 1.1 };
}

/** The short accent rule under a content slide's title. */
export function ruleBox(orientation: SlideOrientation): Box {
	const title = titleBox(orientation);
	return { x: title.x, y: title.y + title.h + 0.05, w: 1, h: 0.06 };
}

/** Everything under a content slide's title and rule, above its number. */
function body(orientation: SlideOrientation): Box {
	const page = pageSize(orientation);
	const m = margin(orientation);
	const rule = ruleBox(orientation);
	const top = rule.y + rule.h + 0.3;
	return { x: m, y: top, w: page.w - 2 * m, h: page.h - m - FOOTER - top };
}

/** Two blocks that share the body: side by side in landscape, stacked in
 *  portrait. `share` is the first block's part of the length they split. */
function split(orientation: SlideOrientation, share: number): [Box, Box] {
	const b = body(orientation);
	if (orientation === 'portrait') {
		const first = (b.h - GAP) * share;
		return [
			{ ...b, h: first },
			{ ...b, y: b.y + first + GAP, h: b.h - first - GAP }
		];
	}
	const first = (b.w - GAP) * share;
	return [
		{ ...b, w: first },
		{ ...b, x: b.x + first + GAP, w: b.w - first - GAP }
	];
}

/** The bullets' box, and the image's when the slide has one. Portrait puts
 *  the image first, above the bullets. */
export function bodyBoxes(
	orientation: SlideOrientation,
	hasImage: boolean
): { bullets: Box; image?: Box } {
	if (!hasImage) return { bullets: body(orientation) };
	if (orientation === 'portrait') {
		const [image, bullets] = split(orientation, 0.45);
		return { bullets, image };
	}
	const [bullets, image] = split(orientation, 0.5);
	return { bullets, image };
}

/** A two-column slide's columns: left then right, or top then bottom. */
export function columnBoxes(orientation: SlideOrientation): { left: Box; right: Box } {
	const [left, right] = split(orientation, 0.5);
	return { left, right };
}

/** A content slide's number, bottom right. */
export function numberBox(orientation: SlideOrientation): Box {
	const page = pageSize(orientation);
	const m = margin(orientation);
	return { x: page.w - m - 1, y: page.h - m - 0.3, w: 1, h: 0.3 };
}

/** A cover slide: a stripe of accent beside a large title, and the subtitle under it. */
export function coverBoxes(orientation: SlideOrientation): {
	stripe: Box;
	title: Box;
	subtitle: Box;
} {
	const page = pageSize(orientation);
	const m = margin(orientation);
	const titleH = orientation === 'portrait' ? 2.8 : 1.9;
	const y = page.h * 0.36;
	const x = m + 0.4;
	const title = { x, y, w: page.w - x - m, h: titleH };
	return {
		stripe: { x: m, y: y + 0.1, w: 0.12, h: titleH + 0.8 },
		title,
		subtitle: { ...title, y: y + titleH, h: 0.9 }
	};
}

/** A section divider: a rule above a left-aligned title, the subtitle under it. */
export function sectionBoxes(orientation: SlideOrientation): {
	rule: Box;
	title: Box;
	subtitle: Box;
} {
	const page = pageSize(orientation);
	const m = margin(orientation);
	const titleH = orientation === 'portrait' ? 2.2 : 1.4;
	const y = page.h / 2 - titleH / 2 - 0.3;
	const title = { x: m, y, w: page.w - 2 * m, h: titleH };
	return {
		rule: { x: m, y: y - 0.2, w: 1.2, h: 0.08 },
		title,
		subtitle: { ...title, y: y + titleH, h: 0.8 }
	};
}

/** An image slide: the picture fills the page, and the title sits on a strip
 *  across its foot. */
export function imageBoxes(orientation: SlideOrientation): {
	page: Box;
	strip: Box;
	title: Box;
	subtitle: Box;
} {
	const page = pageSize(orientation);
	const m = margin(orientation);
	const stripH = orientation === 'portrait' ? 2.8 : 1.9;
	const strip = { x: 0, y: page.h - stripH, w: page.w, h: stripH };
	const titleH = orientation === 'portrait' ? 1.6 : 1.0;
	const title = { x: m, y: strip.y + 0.25, w: page.w - 2 * m, h: titleH };
	return {
		page: { x: 0, y: 0, ...page },
		strip,
		title,
		subtitle: { ...title, y: title.y + titleH, h: stripH - titleH - 0.45 }
	};
}

/** A quote slide: a large opening mark, the quote, and who said it. */
export function quoteBoxes(orientation: SlideOrientation): {
	mark: Box;
	quote: Box;
	speaker: Box;
} {
	const page = pageSize(orientation);
	const m = margin(orientation) + 0.4;
	const quote = { x: m, y: page.h * 0.28, w: page.w - 2 * m, h: page.h * 0.42 };
	return {
		mark: { x: m - 0.15, y: quote.y - 1.3, w: 1.5, h: 1.5 },
		quote,
		speaker: { ...quote, y: quote.y + quote.h + 0.1, h: 0.7 }
	};
}

/** A stat slide: a big number, centred, and what it means under it. */
export function statBoxes(orientation: SlideOrientation): { number: Box; meaning: Box } {
	const page = pageSize(orientation);
	const m = margin(orientation);
	const number = { x: m, y: page.h * 0.24, w: page.w - 2 * m, h: page.h * 0.3 };
	return { number, meaning: { ...number, y: number.y + number.h, h: page.h * 0.22 } };
}

/** A picture of `width` × `height` pixels as large as fits in `box`, centred. */
export function fitImage(box: Box, width: number, height: number): Box {
	const scale = Math.min(box.w / width, box.h / height);
	const w = width * scale;
	const h = height * scale;
	return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/**
 * A picture scaled to cover `box`, and the part of it that shows: `size` is
 * the whole picture at that scale, `crop` the window onto it, relative to its
 * top left. PptxGenJS's `crop` sizing takes them as they are.
 */
export function coverImage(
	box: Box,
	width: number,
	height: number
): { size: { w: number; h: number }; crop: Box } {
	const scale = Math.max(box.w / width, box.h / height);
	const w = width * scale;
	const h = height * scale;
	return { size: { w, h }, crop: { x: (w - box.w) / 2, y: (h - box.h) / 2, w: box.w, h: box.h } };
}
