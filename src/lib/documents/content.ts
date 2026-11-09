import { Lexer, type Token, type Tokens } from 'marked';
import type { Content, TableCell } from 'pdfmake/interfaces';
import { NUMERIC } from '#lib/slides/pptxData.ts';
import { drawable, type Repertoire } from '#lib/documents/glyphs.ts';

/**
 * A model's markdown as pdfmake content: headings, paragraphs with bold,
 * italic, code and links, nested and numbered lists, tables, code blocks,
 * quotes, rules and pictures. Parsed with marked, as chat renders it, so the
 * PDF reads the markdown the way the user saw it.
 */

/** A picture ready to place: its data URL and size in pixels. */
export interface PlacedImage {
	dataUrl: string;
	width: number;
	height: number;
}

export interface ContentContext {
	images: Map<string, PlacedImage>;
	/** What the body font and the code font can draw. */
	body: Repertoire;
	mono: Repertoire;
	/** Characters neither could draw, for the tool result. */
	missing: Set<string>;
	/** The page's content box, in points. */
	width: number;
	height: number;
}

export const CODE_FONT = 'Courier';
const LINK_COLOR = '#1a56b0';
const RULE_COLOR = '#c8ccd2';
const CODE_FILL = '#f3f4f6';
const QUOTE_COLOR = '#555b63';

/** The tokens of `markdown`, as GitHub writes it. */
export function lex(markdown: string): Token[] {
	return new Lexer({ gfm: true }).lex(markdown);
}

/** A paragraph (or a list item's text) that is only pictures, one per line,
 *  is a block of them. */
function standaloneImages(p: { tokens?: Token[] }): Tokens.Image[] | null {
	const images: Tokens.Image[] = [];
	for (const t of p.tokens ?? []) {
		if (t.type === 'image') images.push(t as Tokens.Image);
		else if (!(t.type === 'text' && t.raw.trim() === '')) return null;
	}
	return images.length > 0 ? images : null;
}

/** Every picture the document places, to be read before it is built. */
export function imagePaths(tokens: Token[]): string[] {
	const out: string[] = [];
	const walk = (list: Token[]) => {
		for (const t of list) {
			if (t.type === 'paragraph' || t.type === 'text') {
				for (const img of standaloneImages(t as Tokens.Paragraph) ?? []) out.push(img.href);
			} else if (t.type === 'list') {
				for (const item of (t as Tokens.List).items) walk(item.tokens);
			} else if (t.type === 'blockquote') {
				walk((t as Tokens.Blockquote).tokens);
			}
		}
	};
	walk(tokens);
	return out;
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	mdash: '—',
	ndash: '–',
	hellip: '…',
	copy: '©',
	reg: '®',
	trade: '™',
	deg: '°',
	times: '×',
	euro: '€',
	pound: '£'
};

/** Marked leaves entities as written: `&amp;` is an ampersand on the page. */
export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] === '#') {
			const cp =
				name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1));
			return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

interface RunStyle {
	bold?: boolean;
	italics?: boolean;
	strike?: boolean;
	link?: string;
}

/** A run of inline text: pdfmake's `{ text, bold, … }`. */
type Run = { text: string } & Record<string, unknown>;

function run(text: string, style: RunStyle, ctx: ContentContext, mono = false): Run {
	const out: Run = {
		text: drawable(decodeEntities(text), mono ? ctx.mono : ctx.body, ctx.missing)
	};
	if (style.bold) out.bold = true;
	if (style.italics) out.italics = true;
	if (style.strike) out.decoration = 'lineThrough';
	if (mono) {
		out.font = CODE_FONT;
		out.background = CODE_FILL;
		out.fontSize = 9.5;
	}
	if (style.link) {
		out.link = style.link;
		out.color = LINK_COLOR;
		out.decoration = 'underline';
	}
	return out;
}

/** Only links a reader can follow from a PDF. */
function linkTarget(href: string): string | undefined {
	return /^(https?:|mailto:)/i.test(href) ? href : undefined;
}

/** Inline tokens as runs, carrying the style they sit in. */
export function inline(tokens: Token[], ctx: ContentContext, style: RunStyle = {}): Run[] {
	const out: Run[] = [];
	for (const t of tokens) {
		switch (t.type) {
			case 'strong':
				out.push(...inline((t as Tokens.Strong).tokens, ctx, { ...style, bold: true }));
				break;
			case 'em':
				out.push(...inline((t as Tokens.Em).tokens, ctx, { ...style, italics: true }));
				break;
			case 'del':
				out.push(...inline((t as Tokens.Del).tokens, ctx, { ...style, strike: true }));
				break;
			case 'link': {
				const link = t as Tokens.Link;
				out.push(...inline(link.tokens, ctx, { ...style, link: linkTarget(link.href) }));
				break;
			}
			case 'codespan':
				out.push(run((t as Tokens.Codespan).text, style, ctx, true));
				break;
			case 'br':
				out.push({ text: '\n' });
				break;
			case 'image':
				// A picture inside a sentence can't sit in the line: its alt text does.
				out.push(run(`[${(t as Tokens.Image).text || 'image'}]`, { ...style, italics: true }, ctx));
				break;
			case 'html':
				if (/^<br\s*\/?>$/i.test(t.text.trim())) out.push({ text: '\n' });
				break;
			case 'checkbox':
				break;
			default: {
				const nested = (t as { tokens?: Token[] }).tokens;
				if (nested && nested.length > 0) out.push(...inline(nested, ctx, style));
				else if ('text' in t && typeof t.text === 'string') out.push(run(t.text, style, ctx));
			}
		}
	}
	return out;
}

/** The plain text of inline tokens, for the document's title. */
export function plainText(tokens: Token[]): string {
	return tokens
		.map((t) => {
			const nested = (t as { tokens?: Token[] }).tokens;
			if (nested) return plainText(nested);
			return t.type === 'text' || t.type === 'codespan' || t.type === 'escape'
				? decodeEntities(t.text)
				: '';
		})
		.join('');
}

/** `"center 50%"` in a picture's title: alignment and width, as the other writers read it. */
export function imageOptions(title: string | null | undefined): {
	alignment: 'left' | 'center' | 'right';
	fraction?: number;
} {
	let alignment: 'left' | 'center' | 'right' = 'left';
	let fraction: number | undefined;
	for (const word of (title ?? '').toLowerCase().split(/\s+/)) {
		if (word === 'left' || word === 'right' || word === 'center') alignment = word;
		else if (word === 'centre') alignment = 'center';
		else if (word.endsWith('%')) {
			const pct = parseFloat(word);
			if (Number.isFinite(pct)) fraction = Math.min(100, Math.max(5, pct)) / 100;
		}
	}
	return { alignment, fraction };
}

/**
 * A picture at its natural size (96 dpi, as screenshots and matplotlib
 * output are), or the width its title asks for, never wider than the page
 * nor taller than most of it.
 */
function imageBlock(img: Tokens.Image, ctx: ContentContext): Content {
	const placed = ctx.images.get(img.href);
	// Every path was read before the build; one missing here is a bug.
	if (!placed) throw new Error(`Image ${img.href} was not loaded.`);
	const { alignment, fraction } = imageOptions(img.title);
	const natural = placed.width * 0.75;
	let width = fraction ? ctx.width * fraction : Math.min(natural, ctx.width);
	const maxHeight = ctx.height * 0.85;
	if ((width * placed.height) / placed.width > maxHeight) {
		width = (maxHeight * placed.width) / placed.height;
	}
	return { image: placed.dataUrl, width, alignment, margin: [0, 4, 0, 10] };
}

function codeBlock(code: Tokens.Code, ctx: ContentContext): Content {
	const text = drawable(code.text.replace(/\t/g, '    '), ctx.mono, ctx.missing);
	return {
		table: {
			widths: ['*'],
			body: [
				[{ text, font: CODE_FONT, fontSize: 9, lineHeight: 1.15, preserveLeadingSpaces: true }]
			]
		},
		layout: {
			hLineWidth: () => 0,
			vLineWidth: () => 0,
			fillColor: () => CODE_FILL,
			paddingLeft: () => 8,
			paddingRight: () => 8,
			paddingTop: () => 6,
			paddingBottom: () => 6
		},
		margin: [0, 2, 0, 10]
	};
}

function quoteBlock(quote: Tokens.Blockquote, ctx: ContentContext): Content {
	return {
		table: { widths: ['*'], body: [[{ stack: blocks(quote.tokens, ctx), color: QUOTE_COLOR }]] },
		layout: {
			hLineWidth: () => 0,
			vLineWidth: (i: number) => (i === 0 ? 2.5 : 0),
			vLineColor: () => RULE_COLOR,
			paddingLeft: () => 10,
			paddingRight: () => 0,
			paddingTop: () => 0,
			paddingBottom: () => 0
		},
		margin: [0, 0, 0, 8]
	};
}

/**
 * A table: the header row bold and repeated on each page, numbers on the
 * right unless the markdown aligns the column, and long columns given the
 * room.
 */
function tableBlock(table: Tokens.Table, ctx: ContentContext): Content {
	const columns = table.header.length;
	const texts = [table.header, ...table.rows].map((row) =>
		Array.from({ length: columns }, (_, c) => plainText(row[c]?.tokens ?? []).trim())
	);
	const numeric = Array.from({ length: columns }, (_, c) =>
		texts.slice(1).every((r) => r[c] === '' || NUMERIC.test(r[c]))
	);
	const align = (c: number) => table.align[c] ?? (numeric[c] ? 'right' : 'left');
	const cell = (c: Tokens.TableCell | undefined, col: number, header: boolean): TableCell => ({
		text: inline(c?.tokens ?? [], ctx, header ? { bold: true } : {}),
		alignment: align(col)
	});
	const body: TableCell[][] = [
		table.header.map((c, i) => cell(c, i, true)),
		...table.rows.map((row) => Array.from({ length: columns }, (_, i) => cell(row[i], i, false)))
	];
	// A short column takes what it needs; a long one shares what's left.
	const longest = Array.from({ length: columns }, (_, c) =>
		Math.max(...texts.map((r) => r[c].length))
	);
	const widths = longest.map((n) => (n > 24 ? '*' : 'auto'));
	if (!widths.includes('*')) widths[longest.indexOf(Math.max(...longest))] = '*';
	return {
		table: { headerRows: 1, widths, body, dontBreakRows: true },
		layout: {
			hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
				i === 0 || i === node.table.body.length ? 0 : i === 1 ? 1 : 0.5,
			vLineWidth: () => 0,
			hLineColor: () => RULE_COLOR,
			fillColor: (row: number) => (row === 0 ? '#eef0f3' : null),
			paddingLeft: () => 6,
			paddingRight: () => 6,
			paddingTop: () => 4,
			paddingBottom: () => 4
		},
		fontSize: 10,
		margin: [0, 2, 0, 12]
	};
}

/** A list; one inside an item sits tight against the item after it. */
function listBlock(list: Tokens.List, ctx: ContentContext, nested = false): Content {
	const items = list.items.map((item) => listItem(item, ctx));
	const margin: [number, number, number, number] = [0, 0, 0, nested ? 0 : 8];
	if (list.ordered) {
		const start = typeof list.start === 'number' ? list.start : 1;
		return { ol: items, start, margin };
	}
	return { ul: items, margin };
}

function listItem(item: Tokens.ListItem, ctx: ContentContext): Content {
	const box = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
	const parts: Content[] = [];
	for (const t of item.tokens) {
		if (t.type === 'text') {
			const nested = (t as Tokens.Text).tokens;
			const images = standaloneImages(t as Tokens.Text);
			if (images) parts.push(...images.map((img) => imageBlock(img, ctx)));
			else parts.push({ text: nested ? inline(nested, ctx) : [run(t.text, {}, ctx)] });
		} else if (t.type === 'list') {
			parts.push(listBlock(t as Tokens.List, ctx, true));
		} else if (t.type !== 'checkbox' && t.type !== 'space') {
			parts.push(...blocks([t], ctx));
		}
	}
	if (box && parts.length > 0 && 'text' in (parts[0] as object)) {
		const first = parts[0] as { text: Run[] };
		first.text = [{ text: box }, ...first.text];
	}
	return parts.length === 1 ? parts[0] : { stack: parts };
}

const HEADING_STYLE = ['h1', 'h2', 'h3', 'h4'];

/** Block tokens as pdfmake content. */
export function blocks(tokens: Token[], ctx: ContentContext): Content[] {
	const out: Content[] = [];
	for (const t of tokens) {
		switch (t.type) {
			case 'heading': {
				const h = t as Tokens.Heading;
				out.push({
					text: inline(h.tokens, ctx, { bold: true }),
					style: HEADING_STYLE[Math.min(h.depth, 4) - 1],
					headlineLevel: h.depth
				});
				break;
			}
			case 'paragraph': {
				const p = t as Tokens.Paragraph;
				const images = standaloneImages(p);
				if (images) out.push(...images.map((img) => imageBlock(img, ctx)));
				else out.push({ text: inline(p.tokens, ctx), style: 'p' });
				break;
			}
			case 'text': {
				const nested = (t as Tokens.Text).tokens;
				out.push({ text: nested ? inline(nested, ctx) : [run(t.text, {}, ctx)], style: 'p' });
				break;
			}
			case 'list':
				out.push(listBlock(t as Tokens.List, ctx));
				break;
			case 'code':
				out.push(codeBlock(t as Tokens.Code, ctx));
				break;
			case 'blockquote':
				out.push(quoteBlock(t as Tokens.Blockquote, ctx));
				break;
			case 'table':
				out.push(tableBlock(t as Tokens.Table, ctx));
				break;
			case 'hr':
				out.push({
					canvas: [
						{
							type: 'line',
							x1: 0,
							y1: 0,
							x2: ctx.width,
							y2: 0,
							lineWidth: 0.75,
							lineColor: RULE_COLOR
						}
					],
					margin: [0, 6, 0, 12]
				});
				break;
			case 'html': {
				// Block HTML prints as its text, tags and all stripped.
				const text = t.text.replace(/<[^>]*>/g, '').trim();
				if (text) out.push({ text: [run(text, {}, ctx)], style: 'p' });
				break;
			}
			default:
				break;
		}
	}
	return out;
}
