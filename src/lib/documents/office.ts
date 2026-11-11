import type { SlideImage } from '#lib/slides/types.ts';
import type { Block } from '#lib/documents/model.ts';
import { runText } from '#lib/documents/model.ts';
import { LOOKS, PAGE_POINTS, type DocumentOptions } from '#lib/documents/looks.ts';

/**
 * What the Word and LibreOffice writers share: the page, the title and
 * contents rules the PDF follows (`pdf.ts`), and how big a picture is.
 */

export function escapeXml(text: string): string {
	return (
		text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			// XML 1.0 can't hold most control characters; a model's text may.
			// eslint-disable-next-line no-control-regex -- stripping them is the point
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
	);
}

export interface Prepared {
	tree: Block[];
	/** The document's title: the one asked for, or the first heading. */
	title?: string;
	/** Heading levels the contents list, when it has one. */
	toc?: [number, number];
	/** The page and its margin, in points. */
	page: { width: number; height: number; margin: number };
}

/**
 * The tree as written: a title that repeats the opening heading replaces
 * it, and the contents list the top two heading levels, or the two below a
 * lone top heading.
 */
export function prepare(tree: Block[], options: DocumentOptions): Prepared {
	let body = tree;
	const first = tree.find((b) => b.kind === 'heading');
	const firstText = first?.kind === 'heading' ? runText(first.runs).trim() : undefined;
	if (
		options.title &&
		tree[0]?.kind === 'heading' &&
		firstText?.toLowerCase() === options.title.toLowerCase()
	) {
		body = tree.slice(1);
	}
	const size = PAGE_POINTS[options.pageSize];
	return {
		tree: body,
		title: options.title ?? firstText,
		toc: options.toc ? tocLevels(body) : undefined,
		page: { width: size.width, height: size.height, margin: LOOKS[options.style].margin }
	};
}

function tocLevels(tree: Block[]): [number, number] {
	const depths = tree.flatMap((b) => (b.kind === 'heading' ? [b.level] : []));
	if (depths.length === 0) return [1, 2];
	let top = Math.min(...depths);
	if (depths.filter((d) => d === top).length === 1 && depths.some((d) => d > top)) {
		top = Math.min(...depths.filter((d) => d > top));
	}
	return [top, top + 1];
}

/** A table cell's padding, in characters. */
const CELL_PAD = 2;
/** A table character's average width, as a share of the font size. */
const CHAR_EM = 0.55;

/**
 * Each column's share of a table's width. Word may refit a table when it
 * opens one, but LibreOffice keeps the widths it is given, and an even split
 * breaks a long word in a narrow column. So, as the PDF does (`tableFit.ts`),
 * every column first gets its longest word, then the room left goes to the
 * columns with the longest text. Counted in characters: neither format
 * embeds its font, so there is nothing exact to measure.
 */
export function columnShares(texts: string[][], width: number, fontSize: number): number[] {
	const len = (s: string) => [...s].length;
	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	const least = texts[0].map(
		(_, c) =>
			Math.max(1, ...texts.map((row) => Math.max(...(row[c] ?? '').split(/\s+/).map(len)))) +
			CELL_PAD
	);
	const most = least.map((w, c) =>
		Math.max(w, ...texts.map((row) => len(row[c] ?? '') + CELL_PAD))
	);
	const room = width / (fontSize * CHAR_EM) - sum(least);
	const extra = sum(most) - sum(least);
	const widths =
		room <= 0 || extra === 0
			? least
			: least.map((w, c) => w + (most[c] - w) * Math.min(1, room / extra));
	const total = sum(widths);
	return widths.map((w) => w / total);
}

/**
 * A picture's size in points: its natural size at 96 dpi, or the share of
 * the text width its title asks for, never wider than the text nor taller
 * than most of the page.
 */
export function imageSize(
	img: Pick<SlideImage, 'width' | 'height'>,
	fraction: number | undefined,
	page: Prepared['page']
): { width: number; height: number } {
	const textWidth = page.width - page.margin * 2;
	const maxHeight = (page.height - page.margin * 2) * 0.85;
	let width = fraction ? textWidth * fraction : Math.min(img.width * 0.75, textWidth);
	if ((width * img.height) / img.width > maxHeight) width = (maxHeight * img.width) / img.height;
	return { width, height: (width * img.height) / img.width };
}

/** The extension a picture is stored under. */
export function imageExtension(mime: string): string {
	return mime === 'image/jpeg' ? 'jpeg' : mime.slice('image/'.length);
}
