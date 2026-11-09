import type { Content, Node, NodeQueries, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { Token, Tokens } from 'marked';
import type { SlideImage } from '#lib/slides/types.ts';
import { loadImages } from '#lib/slides/images.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { blocks, imagePaths, lex, plainText, type PlacedImage } from '#lib/documents/content.ts';
import {
	drawable,
	fontCoverage,
	fontMeasure,
	type Coverage,
	type Measure
} from '#lib/documents/glyphs.ts';
import { gifToPng } from '#lib/documents/images.ts';
import { LOOKS, PAGE_POINTS, type Look, type DocumentOptions } from '#lib/documents/looks.ts';

/**
 * A PDF from a model's markdown, built with pdfmake: Roboto embedded, so
 * text in any Latin, Greek or Cyrillic script survives, laid out with the
 * font's own widths. Rust only writes the bytes (`fs_write_pdf`).
 */

const FOOTER = 32;

/** A Letter page in the plain look: what a call without options gets. */
export const DEFAULT_OPTIONS: DocumentOptions = { pageSize: 'letter', style: 'plain', toc: false };

export interface BuiltPdf {
	bytes: Uint8Array;
	pages: number;
	/** Characters the fonts couldn't draw, left out of the page. */
	missing: Set<string>;
	/** Tables too wide for the page, put on a landscape one, by their header. */
	landscaped: string[];
}

type PdfMake = typeof import('pdfmake/build/pdfmake.js');

interface Loaded {
	pdfMake: PdfMake;
	body: Coverage;
	measure: { regular: Measure; bold: Measure };
}

let loaded: Promise<Loaded> | null = null;

/** pdfmake and its fonts, loaded on the first PDF: they are 2.5 MB. */
function loadPdfMake(): Promise<Loaded> {
	loaded ??= (async () => {
		const [{ default: pdfMake }, { default: vfs }, { default: courier }] = await Promise.all([
			import('pdfmake/build/pdfmake.js'),
			import('pdfmake/build/vfs_fonts.js'),
			import('pdfmake/build/standard-fonts/Courier.js')
		]);
		pdfMake.addVirtualFileSystem(vfs);
		pdfMake.addFontContainer(courier as unknown as Parameters<PdfMake['addFontContainer']>[0]);
		const ttf = (name: string) =>
			Uint8Array.from(atob(vfs[name] as string), (c) => c.charCodeAt(0));
		const regular = ttf('Roboto-Regular.ttf');
		// pdfmake's bold Roboto is the Medium weight.
		const measure = { regular: fontMeasure(regular), bold: fontMeasure(ttf('Roboto-Medium.ttf')) };
		return { pdfMake, body: fontCoverage(regular), measure };
	})();
	void loaded.catch(() => (loaded = null));
	return loaded;
}

/** Room a heading needs under its top for itself and a few lines, in points. */
const HEADING_ROOM = 90;

/**
 * A heading goes over to the next page with what it heads when nothing of
 * that is on its page, or when it sits in the last few lines and what it
 * heads runs on. The second catches a table, which pdfmake moves whole to
 * the next page after this has looked at it. The page number, the running
 * title and another heading are not what a heading heads.
 */
export function strandedHeading(node: Node, queries: NodeQueries): boolean {
	if (node.headlineLevel === undefined) return false;
	const following = queries.getFollowingNodesOnPage().filter(heads);
	if (following.length === 0) return true;
	const { pageNumber, pageInnerHeight, verticalRatio } = node.startPosition;
	const room = pageInnerHeight * (1 - verticalRatio);
	return room < HEADING_ROOM && following.some((n) => n.pageNumbers.includes(pageNumber + 1));
}

function heads(n: Node): boolean {
	return n.headlineLevel === undefined && n.style !== 'footer' && n.style !== 'header';
}

/** Images as pdfmake places them: PNG and JPEG as they are. */
export type ImageConverter = (image: SlideImage) => Promise<SlideImage>;

/**
 * Build the PDF. `images` holds every picture the markdown places, read by
 * `loadImages`; pdfmake draws only PNG and JPEG, so `convert` turns a GIF
 * into a PNG first.
 */
export async function buildPdf(
	markdown: string,
	images: Map<string, SlideImage>,
	convert: ImageConverter,
	options: DocumentOptions = DEFAULT_OPTIONS
): Promise<BuiltPdf> {
	const { pdfMake, body, measure } = await loadPdfMake();
	const placed = new Map<string, PlacedImage>();
	for (const [path, img] of images) {
		const ready = img.mime === 'image/gif' ? await convert(img) : img;
		placed.set(path, {
			dataUrl: `data:${ready.mime};base64,${bytesToBase64(ready.bytes)}`,
			width: ready.width,
			height: ready.height
		});
	}
	const look = LOOKS[options.style];
	const page = PAGE_POINTS[options.pageSize];
	const tokens = lex(markdown);
	const headings = tokens.filter((t): t is Tokens.Heading => t.type === 'heading');
	const firstHeading = headings[0] ? plainText(headings[0].tokens).trim() : undefined;
	// A title that repeats the opening heading replaces it.
	const lead = tokens.find((t) => t.type !== 'space');
	if (
		options.title &&
		lead?.type === 'heading' &&
		firstHeading?.toLowerCase() === options.title.toLowerCase()
	) {
		tokens.splice(tokens.indexOf(lead), 1);
	}
	const missing = new Set<string>();
	const ctx = {
		images: placed,
		body,
		mono: 'winansi' as const,
		missing,
		width: page.width - look.margin * 2,
		height: page.height - look.margin * 2 - FOOTER,
		toc: options.toc ? tocLevels(tokens) : undefined,
		measure,
		landscapeWidth: page.height - look.margin * 2,
		pageName: page.called,
		landscaped: [] as string[]
	};
	const content = blocks(tokens, ctx);
	const title = options.title ?? firstHeading;
	const front: Content[] = [];
	if (options.title) front.push(titleBlock(options.title, ctx.width, look, ctx.missing, body));
	if (options.toc) {
		front.push({
			toc: { title: { text: 'Contents', style: 'toc' } },
			pageBreak: 'after'
		});
	}
	let pages = 1;
	const doc: TDocumentDefinitions = {
		pageSize: page.pdfmake,
		pageMargins: [look.margin, look.margin, look.margin, look.margin + FOOTER / 2],
		info: { title, creator: 'Haruspex', producer: 'Haruspex' },
		content: [...front, ...content],
		defaultStyle: { font: 'Roboto', fontSize: look.fontSize, lineHeight: look.lineHeight },
		styles: look.styles,
		header: (n: number): Content | null =>
			look.runningTitle && title && n > 1
				? {
						text: drawable(title, body, new Set()),
						style: 'header',
						margin: [look.margin, 24, look.margin, 0]
					}
				: null,
		footer: (n: number, count: number): Content | null => {
			pages = count;
			return count > 1 && n >= look.numbersFrom
				? { text: `${n} / ${count}`, style: 'footer' }
				: null;
		},
		pageBreakBefore: strandedHeading
	};
	const buffer = await pdfMake.createPdf(doc).getBuffer();
	return { bytes: new Uint8Array(buffer), pages, missing, landscaped: ctx.landscaped };
}

/**
 * The heading levels a table of contents lists: the top two, below a lone
 * top-level heading, which is the document's title.
 */
export function tocLevels(tokens: Token[]): [number, number] {
	const depths = tokens.filter((t) => t.type === 'heading').map((t) => (t as Tokens.Heading).depth);
	if (depths.length === 0) return [1, 2];
	let top = Math.min(...depths);
	if (depths.filter((d) => d === top).length === 1 && depths.some((d) => d > top)) {
		top = Math.min(...depths.filter((d) => d > top));
	}
	return [top, top + 1];
}

/** The title at the head of the first page, over a rule in the report look. */
function titleBlock(
	title: string,
	width: number,
	look: Look,
	missing: Set<string>,
	body: Coverage
): Content {
	const rule: Content = {
		canvas: [
			{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 1.5, lineColor: '#1f4e79' }
		],
		margin: [0, 0, 0, 18]
	};
	const text: Content = { text: drawable(title, body, missing), style: 'title' };
	return look === LOOKS.report ? { stack: [text, rule] } : text;
}

/** The tool result's note on tables turned sideways, or '' when none were. */
export function landscapeNote(tables: string[]): string {
	if (tables.length === 0) return '';
	const which = tables.map((t) => `(${t})`).join('; ');
	const one = tables.length === 1;
	return `${one ? 'A table' : `${tables.length} tables`} too wide for the page ${one ? 'is' : 'are'} on a landscape page: ${which}.`;
}

/**
 * The PDF of `markdown`, its pictures read from `workdir`. Throws a message
 * the model can act on when a picture can't be read: nothing is written.
 */
export async function pdfFromMarkdown(
	workdir: string,
	markdown: string,
	options: DocumentOptions = DEFAULT_OPTIONS
): Promise<BuiltPdf> {
	const images = await loadImages(workdir, imagePaths(lex(markdown)));
	return buildPdf(markdown, images, gifToPng, options);
}
