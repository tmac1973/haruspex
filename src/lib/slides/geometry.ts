import type { SlideOrientation } from '#lib/slides/types.ts';

/**
 * Where each part of a slide goes, in inches, for each orientation. The page
 * is 13.333 × 7.5 in landscape and turned on its side in portrait. Portrait
 * gives titles room for a second line, since the page is narrow, and puts a
 * slide's image above its bullets instead of beside them.
 */

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

const LONG = 13.333;
const SHORT = 7.5;
const MARGIN = 0.5;
/** Between the bullets and the image. */
const GAP = 0.5;

export function pageSize(orientation: SlideOrientation): { w: number; h: number } {
	return orientation === 'portrait' ? { w: SHORT, h: LONG } : { w: LONG, h: SHORT };
}

/** A section slide's title, centred on the page, and its subtitle under it. */
export function sectionBoxes(orientation: SlideOrientation): { title: Box; subtitle: Box } {
	const page = pageSize(orientation);
	const title = { x: 1, y: page.h / 2 - 1.25, w: page.w - 2, h: 1.667 };
	return { title, subtitle: { ...title, y: title.y + title.h + 0.167, h: 0.833 } };
}

/** A content slide's title, full width at the top. */
export function titleBox(orientation: SlideOrientation): Box {
	const page = pageSize(orientation);
	const h = orientation === 'portrait' ? 1.75 : 1.25;
	return { x: MARGIN, y: MARGIN, w: page.w - 2 * MARGIN, h };
}

/** The bullets' box, and the image's when the slide has one. */
export function bodyBoxes(
	orientation: SlideOrientation,
	hasImage: boolean
): { bullets: Box; image?: Box } {
	const page = pageSize(orientation);
	const title = titleBox(orientation);
	const top = title.y + title.h + 0.25;
	const full = { x: MARGIN, y: top, w: page.w - 2 * MARGIN, h: page.h - MARGIN - top };
	if (!hasImage) return { bullets: full };
	if (orientation === 'portrait') {
		const imageH = full.h * 0.45;
		return {
			image: { ...full, h: imageH },
			bullets: { ...full, y: top + imageH + GAP, h: full.h - imageH - GAP }
		};
	}
	const half = (full.w - GAP) / 2;
	return {
		bullets: { ...full, w: half },
		image: { ...full, x: full.x + half + GAP, w: half }
	};
}

/** A picture of `width` × `height` pixels as large as fits in `box`, centred. */
export function fitImage(box: Box, width: number, height: number): Box {
	const scale = Math.min(box.w / width, box.h / height);
	const w = width * scale;
	const h = height * scale;
	return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}
