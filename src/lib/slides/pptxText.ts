import type PptxGenJS from 'pptxgenjs';
import type { Box } from '#lib/slides/geometry.ts';
import { boldRuns, plainText } from '#lib/slides/markdown.ts';
import { OVERFLOW_LIMIT, fitHeight, textHeight, textProblem } from '#lib/slides/textfit.ts';
import type { Paragraph } from '#lib/slides/textfit.ts';
import type { Sizes } from '#lib/slides/sizes.ts';
import type { Theme } from '#lib/slides/themes.ts';
import type { SlideBullet, SlideOrientation } from '#lib/slides/types.ts';

/**
 * The text side of a .pptx build: fitting text to its box (textfit.ts's
 * estimate), single fitted runs, and bullets. pptx.ts lays out the slides.
 */

/** Space before each bullet after the first, in points. */
const BULLET_GAP = 8;
/** How far each nesting level indents its bullet, in inches (PptxGenJS's). */
const BULLET_INDENT = 0.375;
/** Space before a stacked second column, in points. */
const COLUMN_BREAK = 28;

/** One deck's build: what every slide draws with, and the text that didn't fit. */
export interface Build {
	deck: PptxGenJS;
	orientation: SlideOrientation;
	theme: Theme;
	sizes: Sizes;
	problems: string[];
	/** A paragraph has more than one run, so the deck needs `dropStrayParagraphProps`. */
	mixedRuns: boolean;
}

export const at = (box: Box) => ({ x: box.x, y: box.y, w: box.w, h: box.h });

function bulletLevel(b: SlideBullet): number {
	const raw = typeof b === 'string' ? 0 : (b.level ?? 0);
	return Math.min(Math.max(Math.trunc(raw), 0), 2);
}

const bulletText = (b: SlideBullet) => (typeof b === 'string' ? b : b.text).trim();

function bulletParagraphs(bullets: SlideBullet[], sizes: number[]): Paragraph[] {
	return bullets.map((b) => {
		const level = bulletLevel(b);
		return {
			text: plainText(bulletText(b)),
			pt: sizes[level],
			indent: BULLET_INDENT * (level + 1)
		};
	});
}

/** The scale `paras` fit `box` at, noting a problem when even the smallest
 *  step leaves them well over. */
export function fit(
	build: Build,
	where: string,
	what: string,
	paras: Paragraph[],
	box: Box,
	gap = 0,
	extraPt = 0
): number {
	const height = (s: number) => textHeight(paras, box.w, s, gap) + (extraPt * s) / 72;
	const { scale, ratio } = fitHeight(height, box.h);
	if (ratio > OVERFLOW_LIMIT) build.problems.push(textProblem(where, what, paras, box.w, ratio));
	return scale;
}

/** A single run of text, shrunk to fit its box. */
export function addFitted(
	build: Build,
	out: PptxGenJS.Slide,
	where: string,
	what: string,
	text: string,
	box: Box,
	pt: number,
	options: PptxGenJS.TextPropsOptions
): void {
	const scale = fit(build, where, what, [{ text, pt, indent: 0 }], box);
	out.addText(text, { ...at(box), fontSize: Math.round(pt * scale), ...options });
}

/** Space a stacked column break adds over a bullet's, in points. */
const breakExtra = (breakAt?: number) => (breakAt === undefined ? 0 : COLUMN_BREAK - BULLET_GAP);

/** The scale `bullets` fit `box` at (see `fit`); `breakAt` as in `addBullets`. */
export function fitBullets(
	build: Build,
	where: string,
	what: string,
	bullets: SlideBullet[],
	box: Box,
	breakAt?: number
): number {
	const paras = bulletParagraphs(bullets, build.sizes.bullets);
	return fit(build, where, what, paras, box, BULLET_GAP, breakExtra(breakAt));
}

/**
 * Where `middle` bullets go: centred in the top three quarters of `box`, a
 * little above the middle, where a short list doesn't drift away from its
 * title. A list that needs more takes the whole box.
 */
function raisedBox(
	build: Build,
	bullets: SlideBullet[],
	box: Box,
	scale: number,
	breakAt?: number
) {
	const paras = bulletParagraphs(bullets, build.sizes.bullets);
	const needed = textHeight(paras, box.w, scale, BULLET_GAP) + (breakExtra(breakAt) * scale) / 72;
	return { ...box, h: Math.min(box.h, Math.max(box.h * 0.75, needed)) };
}

/**
 * Bullets at `scale`, each one paragraph of plain and bold runs. `breakAt`
 * puts a wider space before that bullet: where a stacked second column
 * starts. `middle` centres them, a little above the middle (`raisedBox`).
 */
export function addBullets(
	build: Build,
	out: PptxGenJS.Slide,
	bullets: SlideBullet[],
	box: Box,
	scale: number,
	{ breakAt, middle = false }: { breakAt?: number; middle?: boolean } = {}
): void {
	if (bullets.length === 0) return;
	const sizes = build.sizes.bullets;
	const runs = bullets.flatMap((b, i) => {
		const level = bulletLevel(b);
		const parts = boldRuns(bulletText(b));
		if (parts.length > 1) build.mixedRuns = true;
		// PptxGenJS starts a paragraph at every run with `bullet`, so only the
		// first run has the paragraph's settings.
		const paragraph = {
			bullet: true,
			indentLevel: level,
			paraSpaceBefore: i === 0 ? 0 : Math.round((i === breakAt ? COLUMN_BREAK : BULLET_GAP) * scale)
		};
		return parts.map((part, j) => ({
			text: part.text,
			options: {
				...(j === 0 ? paragraph : {}),
				bold: part.bold,
				fontSize: Math.round(sizes[level] * scale),
				breakLine: j === parts.length - 1
			}
		}));
	});
	out.addText(runs, {
		...at(middle ? raisedBox(build, bullets, box, scale, breakAt) : box),
		valign: middle ? 'middle' : 'top',
		color: build.theme.text,
		fontFace: build.theme.bodyFont
	});
}
