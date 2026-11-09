import type { Content, Node, NodeQueries, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { Tokens } from 'marked';
import type { SlideImage } from '#lib/slides/types.ts';
import { loadImages } from '#lib/slides/images.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { blocks, imagePaths, lex, plainText, type PlacedImage } from '#lib/documents/content.ts';
import { fontCoverage, type Coverage } from '#lib/documents/glyphs.ts';
import { gifToPng } from '#lib/documents/images.ts';

/**
 * A PDF from a model's markdown, built with pdfmake: Roboto embedded, so
 * text in any Latin, Greek or Cyrillic script survives, laid out with the
 * font's own widths. Rust only writes the bytes (`fs_write_pdf`).
 */

/** US Letter, in points, with a margin of about 20 mm. */
const PAGE = { width: 612, height: 792, margin: 56 };
const FOOTER = 32;

export interface BuiltPdf {
	bytes: Uint8Array;
	pages: number;
	/** Characters the fonts couldn't draw, left out of the page. */
	missing: Set<string>;
}

type PdfMake = typeof import('pdfmake/build/pdfmake.js');

let loaded: Promise<{ pdfMake: PdfMake; body: Coverage }> | null = null;

/** pdfmake and its fonts, loaded on the first PDF: they are 2.5 MB. */
function loadPdfMake(): Promise<{ pdfMake: PdfMake; body: Coverage }> {
	loaded ??= (async () => {
		const [{ default: pdfMake }, { default: vfs }, { default: courier }] = await Promise.all([
			import('pdfmake/build/pdfmake.js'),
			import('pdfmake/build/vfs_fonts.js'),
			import('pdfmake/build/standard-fonts/Courier.js')
		]);
		pdfMake.addVirtualFileSystem(vfs);
		pdfMake.addFontContainer(courier as unknown as Parameters<PdfMake['addFontContainer']>[0]);
		const regular = Uint8Array.from(atob(vfs['Roboto-Regular.ttf'] as string), (c) =>
			c.charCodeAt(0)
		);
		return { pdfMake, body: fontCoverage(regular) };
	})();
	void loaded.catch(() => (loaded = null));
	return loaded;
}

const STYLES: TDocumentDefinitions['styles'] = {
	h1: { fontSize: 20, margin: [0, 6, 0, 8] },
	h2: { fontSize: 15.5, margin: [0, 12, 0, 6] },
	h3: { fontSize: 13, margin: [0, 10, 0, 4] },
	h4: { fontSize: 11.5, margin: [0, 8, 0, 4] },
	p: { margin: [0, 0, 0, 8] },
	footer: { alignment: 'center', fontSize: 9, color: '#80868f' }
};

/**
 * A heading with nothing of its own after it on the page goes over with what
 * it heads. The page number counts as a node on the page, so it is skipped
 * by its style; another heading is not something this one heads.
 */
export function strandedHeading(node: Node, queries: NodeQueries): boolean {
	if (node.headlineLevel === undefined) return false;
	return !queries
		.getFollowingNodesOnPage()
		.some((n) => n.style !== 'footer' && n.headlineLevel === undefined);
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
	convert: ImageConverter
): Promise<BuiltPdf> {
	const { pdfMake, body } = await loadPdfMake();
	const placed = new Map<string, PlacedImage>();
	for (const [path, img] of images) {
		const ready = img.mime === 'image/gif' ? await convert(img) : img;
		placed.set(path, {
			dataUrl: `data:${ready.mime};base64,${bytesToBase64(ready.bytes)}`,
			width: ready.width,
			height: ready.height
		});
	}
	const tokens = lex(markdown);
	const missing = new Set<string>();
	const content = blocks(tokens, {
		images: placed,
		body,
		mono: 'winansi',
		missing,
		width: PAGE.width - PAGE.margin * 2,
		height: PAGE.height - PAGE.margin * 2 - FOOTER
	});
	const heading = tokens.find((t) => t.type === 'heading') as Tokens.Heading | undefined;
	let pages = 1;
	const doc: TDocumentDefinitions = {
		pageSize: 'LETTER',
		pageMargins: [PAGE.margin, PAGE.margin, PAGE.margin, PAGE.margin + FOOTER / 2],
		info: {
			title: heading ? plainText(heading.tokens).trim() : undefined,
			creator: 'Haruspex',
			producer: 'Haruspex'
		},
		content,
		defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.3 },
		styles: STYLES,
		footer: (page: number, count: number): Content | null => {
			pages = count;
			return count > 1 ? { text: `${page} / ${count}`, style: 'footer' } : null;
		},
		pageBreakBefore: strandedHeading
	};
	const buffer = await pdfMake.createPdf(doc).getBuffer();
	return { bytes: new Uint8Array(buffer), pages, missing };
}

/**
 * The PDF of `markdown`, its pictures read from `workdir`. Throws a message
 * the model can act on when a picture can't be read: nothing is written.
 */
export async function pdfFromMarkdown(workdir: string, markdown: string): Promise<BuiltPdf> {
	const images = await loadImages(workdir, imagePaths(lex(markdown)));
	return buildPdf(markdown, images, gifToPng);
}
