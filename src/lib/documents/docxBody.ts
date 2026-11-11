import type { SlideImage } from '#lib/slides/types.ts';
import { runText, type Block, type ListItem, type Run } from '#lib/documents/model.ts';
import {
	columnShares,
	escapeXml,
	imageExtension,
	imageSize,
	type Prepared
} from '#lib/documents/office.ts';

/**
 * The body of a Word document (`word/document.xml`) from the tree: styles
 * by name (`docx.ts` defines them), lists through numbering instances, and
 * the pictures and links it needs relationships for.
 */

/** Points to the units Word measures in. */
export const TWIPS = 20;
const EMU = 12700;
/** A table's text size, in points: the body's, as every look has it. */
const TABLE_SIZE = 11;
/** A list level's indent, in twips. */
export const LIST_INDENT = 360;

export interface DocxParts {
	/** Pictures by path: their part name and relationship id. */
	media: Map<string, { id: string; file: string; image: SlideImage }>;
	/** Links by address: their relationship id. */
	links: Map<string, string>;
	/** Ordered lists, each its own numbering instance: its level and first number. */
	numbered: { level: number; start: number }[];
}

export class DocxBody {
	readonly parts: DocxParts = { media: new Map(), links: new Map(), numbered: [] };
	private drawings = 0;

	constructor(
		private readonly doc: Prepared,
		private readonly images: Map<string, SlideImage>
	) {}

	/** The blocks as paragraphs and tables. */
	blocks(tree: Block[], quote = false): string {
		return tree.map((b) => this.block(b, quote)).join('');
	}

	private block(b: Block, quote: boolean): string {
		switch (b.kind) {
			case 'heading':
				return paragraph(`<w:pStyle w:val="Heading${b.level}"/>`, this.runs(b.runs));
			case 'paragraph':
				return paragraph(quote ? '<w:pStyle w:val="Quote"/>' : '', this.runs(b.runs));
			case 'list':
				return this.list(b, 0);
			case 'code':
				return codeParagraph(b.text);
			case 'quote':
				return this.blocks(b.blocks, true);
			case 'table':
				return this.table(b);
			case 'rule':
				return paragraph(
					'<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C8CCD2"/></w:pBdr>',
					''
				);
			case 'image':
				return this.image(b, '');
		}
	}

	private list(l: Extract<Block, { kind: 'list' }>, depth: number): string {
		let numId = 1;
		if (l.ordered) {
			this.parts.numbered.push({ level: depth, start: l.start });
			// Instance 1 is the bullets; ordered lists follow it.
			numId = this.parts.numbered.length + 1;
		}
		return l.items.map((item) => this.item(item, depth, numId)).join('');
	}

	/** An item: its first paragraph numbered, the rest indented under it. */
	private item(item: ListItem, depth: number, numId: number): string {
		const indent = `<w:ind w:left="${LIST_INDENT * (depth + 1)}"/>`;
		let first = true;
		let out = '';
		for (const b of item.blocks) {
			if (b.kind === 'list') {
				out += this.list(b, depth + 1);
			} else if (b.kind === 'paragraph' && first) {
				const box = item.checked === undefined ? [] : [{ text: item.checked ? '☒ ' : '☐ ' }];
				const props =
					item.checked === undefined
						? `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="${numId}"/></w:numPr>`
						: `<w:pStyle w:val="ListParagraph"/>${indent}`;
				out += paragraph(props, this.runs([...box, ...b.runs]));
			} else if (b.kind === 'paragraph') {
				out += paragraph(`<w:pStyle w:val="ListParagraph"/>${indent}`, this.runs(b.runs));
			} else if (b.kind === 'image') {
				out += this.image(b, indent);
			} else {
				out += this.block(b, false);
			}
			first = false;
		}
		return out;
	}

	/** Runs, the ones that share a link inside one hyperlink. */
	runs(runs: Run[]): string {
		let out = '';
		for (let i = 0; i < runs.length;) {
			const link = runs[i].link;
			if (!link) {
				out += run(runs[i++]);
				continue;
			}
			let inner = '';
			while (i < runs.length && runs[i].link === link) inner += run(runs[i++]);
			out += `<w:hyperlink r:id="${this.linkId(link)}" w:history="1">${inner}</w:hyperlink>`;
		}
		return out;
	}

	private linkId(href: string): string {
		let id = this.parts.links.get(href);
		if (!id) {
			id = `rIdLink${this.parts.links.size + 1}`;
			this.parts.links.set(href, id);
		}
		return id;
	}

	private table(t: Extract<Block, { kind: 'table' }>): string {
		const textWidth = this.doc.page.width - this.doc.page.margin * 2;
		const texts = [t.header, ...t.rows].map((r) => r.map(runText));
		const grid = columnShares(texts, textWidth, TABLE_SIZE)
			.map((share) => `<w:gridCol w:w="${Math.floor(share * textWidth * TWIPS)}"/>`)
			.join('');
		const cell = (runs: Run[], c: number, header: boolean) => {
			const shade = header ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF0F3"/>' : '';
			const jc = t.align[c] === 'left' ? '' : `<w:jc w:val="${t.align[c]}"/>`;
			const text = header ? runs.map((r) => ({ ...r, bold: true })) : runs;
			return `<w:tc><w:tcPr>${shade}</w:tcPr>${paragraph(`<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>${jc}`, this.runs(text))}</w:tc>`;
		};
		const row = (cells: Run[][], header: boolean) =>
			`<w:tr><w:trPr><w:cantSplit/>${header ? '<w:tblHeader/>' : ''}</w:trPr>${cells.map((r, c) => cell(r, c, header)).join('')}</w:tr>`;
		const border = (side: string, size: number) =>
			`<w:${side} w:val="${size ? 'single' : 'nil'}" w:sz="${size}" w:space="0" w:color="C8CCD2"/>`;
		return (
			'<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>' +
			border('top', 0) +
			border('left', 0) +
			border('bottom', 4) +
			border('right', 0) +
			border('insideH', 4) +
			border('insideV', 0) +
			'</w:tblBorders><w:tblLayout w:type="autofit"/><w:tblCellMar>' +
			'<w:top w:w="60" w:type="dxa"/><w:left w:w="110" w:type="dxa"/>' +
			'<w:bottom w:w="60" w:type="dxa"/><w:right w:w="110" w:type="dxa"/>' +
			'</w:tblCellMar></w:tblPr><w:tblGrid>' +
			grid +
			'</w:tblGrid>' +
			row(t.header, true) +
			t.rows.map((r) => row(r, false)).join('') +
			// Word runs two tables together without a paragraph between them.
			'</w:tbl><w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
		);
	}

	private image(b: Extract<Block, { kind: 'image' }>, indent: string): string {
		const img = this.images.get(b.path);
		// Every path was read before the build; one missing here is a bug.
		if (!img) throw new Error(`Image ${b.path} was not loaded.`);
		let media = this.parts.media.get(b.path);
		if (!media) {
			const n = this.parts.media.size + 1;
			media = { id: `rIdImg${n}`, file: `image${n}.${imageExtension(img.mime)}`, image: img };
			this.parts.media.set(b.path, media);
		}
		const size = imageSize(img, b.fraction, this.doc.page);
		const cx = Math.round(size.width * EMU);
		const cy = Math.round(size.height * EMU);
		const n = ++this.drawings;
		const jc = b.align === 'left' ? '' : `<w:jc w:val="${b.align}"/>`;
		const drawing =
			`<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
			`<wp:docPr id="${n}" name="Picture ${n}" descr="${escapeXml(b.alt)}"/>` +
			'<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
			'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
			`<pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${media.file}"/><pic:cNvPicPr/></pic:nvPicPr>` +
			`<pic:blipFill><a:blip r:embed="${media.id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
			`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
			'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
			'</a:graphicData></a:graphic></wp:inline></w:drawing>';
		return paragraph(`${indent}${jc}`, `<w:r>${drawing}</w:r>`);
	}
}

export function paragraph(props: string, content: string): string {
	return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${content}</w:p>`;
}

/** Text in a run, its spaces kept and its line breaks as breaks. */
export function text(value: string): string {
	return value
		.split('\n')
		.map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
		.join('<w:br/>');
}

function run(r: Run): string {
	if (r.br) return '<w:r><w:br/></w:r>';
	let props = '';
	if (r.code) props += '<w:rStyle w:val="CodeChar"/>';
	else if (r.link) props += '<w:rStyle w:val="Hyperlink"/>';
	if (r.bold) props += '<w:b/>';
	if (r.italic) props += '<w:i/>';
	if (r.strike) props += '<w:strike/>';
	return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${text(r.text)}</w:r>`;
}

/** A code block: one shaded paragraph, its lines kept apart by breaks. */
function codeParagraph(code: string): string {
	return paragraph('<w:pStyle w:val="Code"/>', `<w:r>${text(code.replace(/\n$/, ''))}</w:r>`);
}
