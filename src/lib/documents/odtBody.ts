import type { SlideImage } from '#lib/slides/types.ts';
import type { Align, Block, ListItem, Run } from '#lib/documents/model.ts';
import { escapeXml, imageExtension, imageSize, type Prepared } from '#lib/documents/office.ts';

/**
 * The body of a LibreOffice document (`content.xml`) from the tree. Named
 * styles live in `styles.xml` (`odt.ts`); a run's bold, italic and so on
 * are automatic styles, made here as they're used.
 */

export class OdtBody {
	/** Pictures by path: their file under Pictures/ and the image. */
	readonly media = new Map<string, { file: string; image: SlideImage }>();
	/** Automatic text styles by name: their properties. */
	readonly textStyles = new Map<string, string>();
	private frames = 0;
	private tables = 0;

	constructor(
		private readonly doc: Prepared,
		private readonly images: Map<string, SlideImage>
	) {}

	blocks(tree: Block[], quote = false): string {
		return tree.map((b) => this.block(b, quote)).join('');
	}

	private block(b: Block, quote: boolean): string {
		switch (b.kind) {
			case 'heading':
				return `<text:h text:style-name="Heading_20_${b.level}" text:outline-level="${b.level}">${this.runs(b.runs)}</text:h>`;
			case 'paragraph':
				return para(quote ? 'Quotations' : 'Text_20_body', this.runs(b.runs));
			case 'list':
				return this.list(b);
			case 'code':
				return para('Preformatted_20_Text', spaced(b.text.replace(/\n$/, '')));
			case 'quote':
				return this.blocks(b.blocks, true);
			case 'table':
				return this.table(b);
			case 'rule':
				return para('Horizontal_20_Line', '');
			case 'image':
				return this.image(b);
		}
	}

	/** A list, its style by kind; a new one restarts its numbers. */
	private list(l: Extract<Block, { kind: 'list' }>): string {
		const checklist = l.items.every((i) => i.checked !== undefined);
		const style = checklist ? 'Checklist' : l.ordered ? 'Numbering_20_123' : 'List_20_Bullet';
		const items = l.items.map((item, i) =>
			this.item(item, l.ordered && i === 0 ? l.start : undefined)
		);
		return `<text:list text:style-name="${style}">${items.join('')}</text:list>`;
	}

	private item(item: ListItem, start: number | undefined): string {
		const box = item.checked === undefined ? [] : [{ text: item.checked ? '☒ ' : '☐ ' }];
		let first = true;
		const inner = item.blocks.map((b) => {
			if (b.kind === 'paragraph') {
				const runs = first ? [...box, ...b.runs] : b.runs;
				first = false;
				return para('List_20_Contents', this.runs(runs));
			}
			first = false;
			return b.kind === 'list' ? this.list(b) : this.block(b, false);
		});
		const startAt = start !== undefined && start !== 1 ? ` text:start-value="${start}"` : '';
		return `<text:list-item${startAt}>${inner.join('') || para('List_20_Contents', '')}</text:list-item>`;
	}

	/** Runs, styled, with links around the ones that have them. */
	runs(runs: Run[]): string {
		let out = '';
		for (let i = 0; i < runs.length;) {
			const link = runs[i].link;
			if (!link) {
				out += this.run(runs[i++]);
				continue;
			}
			let inner = '';
			while (i < runs.length && runs[i].link === link) inner += this.run(runs[i++]);
			out += `<text:a xlink:type="simple" xlink:href="${escapeXml(link)}" text:style-name="Internet_20_link">${inner}</text:a>`;
		}
		return out;
	}

	private run(r: Run): string {
		if (r.br) return '<text:line-break/>';
		const style = this.textStyle(r);
		const body = spaced(r.text);
		return style ? `<text:span text:style-name="${style}">${body}</text:span>` : body;
	}

	/** The automatic style for a run's look, made the first time it's needed. */
	private textStyle(r: Run): string | undefined {
		const key = `${r.bold ? 'b' : ''}${r.italic ? 'i' : ''}${r.strike ? 's' : ''}${r.code ? 'c' : ''}`;
		if (!key) return undefined;
		const name = `T_${key}`;
		if (!this.textStyles.has(name)) {
			let props = '';
			if (r.bold)
				props +=
					' fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"';
			if (r.italic)
				props +=
					' fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"';
			if (r.strike)
				props += ' style:text-line-through-style="solid" style:text-line-through-type="single"';
			if (r.code)
				props +=
					' style:font-name="Courier New" fo:font-size="9.5pt" fo:background-color="#f3f4f6"';
			this.textStyles.set(name, props);
		}
		return name;
	}

	private table(t: Extract<Block, { kind: 'table' }>): string {
		const n = ++this.tables;
		const cell = (runs: Run[], c: number, header: boolean) =>
			`<table:table-cell table:style-name="${header ? 'Cell_Head' : 'Cell'}" office:value-type="string">` +
			para(cellStyle(t.align[c], header), this.runs(runs)) +
			'</table:table-cell>';
		const row = (cells: Run[][], header: boolean) =>
			`<table:table-row>${cells.map((r, c) => cell(r, c, header)).join('')}</table:table-row>`;
		return (
			`<table:table table:name="Table${n}" table:style-name="Table">` +
			`<table:table-column table:number-columns-repeated="${t.align.length}"/>` +
			`<table:table-header-rows>${row(t.header, true)}</table:table-header-rows>` +
			t.rows.map((r) => row(r, false)).join('') +
			'</table:table>'
		);
	}

	private image(b: Extract<Block, { kind: 'image' }>): string {
		const img = this.images.get(b.path);
		// Every path was read before the build; one missing here is a bug.
		if (!img) throw new Error(`Image ${b.path} was not loaded.`);
		let media = this.media.get(b.path);
		if (!media) {
			media = { file: `image${this.media.size + 1}.${imageExtension(img.mime)}`, image: img };
			this.media.set(b.path, media);
		}
		const size = imageSize(img, b.fraction, this.doc.page);
		const n = ++this.frames;
		const frame =
			`<draw:frame draw:name="Picture ${n}" text:anchor-type="as-char" ` +
			`svg:width="${size.width.toFixed(2)}pt" svg:height="${size.height.toFixed(2)}pt" draw:z-index="0">` +
			`<draw:image xlink:href="Pictures/${media.file}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>` +
			(b.alt ? `<svg:desc>${escapeXml(b.alt)}</svg:desc>` : '') +
			'</draw:frame>';
		return para(`Picture_${b.align}`, frame);
	}
}

export function para(style: string, content: string): string {
	return `<text:p text:style-name="${style}">${content}</text:p>`;
}

function cellStyle(align: Align, header: boolean): string {
	return `${header ? 'Table_20_Heading' : 'Table_20_Contents'}_${align}`;
}

/**
 * Text as ODF holds it: a run of spaces collapses to one unless written as
 * `<text:s>`, and a tab or a line break is an element of its own.
 */
export function spaced(text: string): string {
	return text
		.split('\n')
		.map((line) =>
			escapeXml(line)
				.replace(/\t/g, '<text:tab/>')
				.replace(/^ +| {2,}/g, (spaces, at: number) => {
					// The first of a run inside the line is an ordinary space.
					const kept = at === 0 ? 0 : 1;
					const n = spaces.length - kept;
					return ' '.repeat(kept) + (n === 1 ? '<text:s/>' : `<text:s text:c="${n}"/>`);
				})
		)
		.join('<text:line-break/>');
}
