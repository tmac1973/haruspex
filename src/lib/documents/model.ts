import type { Token, Tokens } from 'marked';
import { NUMERIC } from '#lib/slides/pptxData.ts';
import {
	decodeEntities,
	imageOptions,
	lex,
	plainText,
	standaloneImages
} from '#lib/documents/content.ts';

/**
 * A model's markdown as a plain document tree, for the writers that make
 * Word (`docx.ts`) and LibreOffice (`odt.ts`) files. Read from marked's
 * tokens, as the PDF is (`content.ts`), so the three formats agree on what
 * the markdown says.
 */

export interface Run {
	text: string;
	bold?: boolean;
	italic?: boolean;
	strike?: boolean;
	code?: boolean;
	/** A web or mail address; links into the folder are left as text. */
	link?: string;
	/** A line break inside the paragraph, in place of text. */
	br?: boolean;
}

export type Align = 'left' | 'center' | 'right';

export interface ListItem {
	blocks: Block[];
	/** A checklist item: ticked or not. */
	checked?: boolean;
}

export type Block =
	| { kind: 'heading'; level: number; runs: Run[] }
	| { kind: 'paragraph'; runs: Run[] }
	| { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
	| { kind: 'code'; text: string }
	| { kind: 'quote'; blocks: Block[] }
	| { kind: 'table'; align: Align[]; header: Run[][]; rows: Run[][][] }
	| { kind: 'rule' }
	| { kind: 'image'; path: string; alt: string; align: Align; fraction?: number };

/** The document tree of `markdown`. */
export function documentModel(markdown: string): Block[] {
	return blocks(lex(markdown));
}

function blocks(tokens: Token[]): Block[] {
	return tokens.flatMap(block);
}

function block(t: Token): Block[] {
	switch (t.type) {
		case 'heading': {
			const h = t as Tokens.Heading;
			return [{ kind: 'heading', level: Math.min(h.depth, 6), runs: runs(h.tokens) }];
		}
		case 'paragraph':
		case 'text':
			return textBlock(t as Tokens.Paragraph);
		case 'list':
			return [list(t as Tokens.List)];
		case 'code':
			return [{ kind: 'code', text: (t as Tokens.Code).text.replace(/\t/g, '    ') }];
		case 'blockquote':
			return [{ kind: 'quote', blocks: blocks((t as Tokens.Blockquote).tokens) }];
		case 'table':
			return [table(t as Tokens.Table)];
		case 'hr':
			return [{ kind: 'rule' }];
		case 'html': {
			// Block HTML is written as its text, tags and all stripped.
			const text = decodeEntities(t.text.replace(/<[^>]*>/g, '').trim());
			return text ? [{ kind: 'paragraph', runs: [{ text }] }] : [];
		}
		default:
			return [];
	}
}

/** A paragraph, or the pictures it is when it holds only pictures. */
function textBlock(p: { tokens?: Token[]; text: string }): Block[] {
	const images = standaloneImages(p);
	if (images) return images.map(image);
	return [
		{ kind: 'paragraph', runs: p.tokens ? runs(p.tokens) : [{ text: decodeEntities(p.text) }] }
	];
}

function image(img: Tokens.Image): Block {
	const { alignment, fraction } = imageOptions(img.title);
	return { kind: 'image', path: img.href, alt: img.text, align: alignment, fraction };
}

function list(l: Tokens.List): Block {
	const items = l.items.map((item) => ({
		blocks: blocks(item.tokens.filter((t) => t.type !== 'checkbox')),
		...(item.task && { checked: !!item.checked })
	}));
	const start = typeof l.start === 'number' ? l.start : 1;
	return { kind: 'list', ordered: l.ordered, start, items };
}

/** Numbers on the right unless the markdown aligns the column, as in the PDF. */
function table(t: Tokens.Table): Block {
	const columns = t.header.length;
	const cells = (row: Tokens.TableCell[]) =>
		Array.from({ length: columns }, (_, c) => runs(row[c]?.tokens ?? []));
	const numeric = Array.from({ length: columns }, (_, c) =>
		t.rows.every((row) => {
			const text = plainText(row[c]?.tokens ?? []).trim();
			return text === '' || NUMERIC.test(text);
		})
	);
	const align = Array.from(
		{ length: columns },
		(_, c): Align => t.align[c] ?? (numeric[c] && t.rows.length > 0 ? 'right' : 'left')
	);
	return { kind: 'table', align, header: cells(t.header), rows: t.rows.map(cells) };
}

interface Style {
	bold?: boolean;
	italic?: boolean;
	strike?: boolean;
	link?: string;
}

/** Inline tokens as runs, carrying the style they sit in. */
export function runs(tokens: Token[], style: Style = {}): Run[] {
	return tokens.flatMap((t) => inlineRuns(t, style));
}

/** The tokens that only style what they hold. */
const STYLING: Record<string, Style> = {
	strong: { bold: true },
	em: { italic: true },
	del: { strike: true }
};

function inlineRuns(t: Token, style: Style): Run[] {
	const styling = STYLING[t.type];
	if (styling) return runs((t as Tokens.Strong).tokens, { ...style, ...styling });
	switch (t.type) {
		case 'link': {
			const link = t as Tokens.Link;
			const href = /^(https?:|mailto:)/i.test(link.href) ? link.href : undefined;
			return runs(link.tokens, { ...style, link: href });
		}
		case 'codespan':
			return [{ ...style, text: decodeEntities((t as Tokens.Codespan).text), code: true }];
		case 'br':
			return [{ text: '', br: true }];
		case 'image':
			// A picture inside a sentence can't sit in the line: its alt text does.
			return [{ ...style, text: `[${(t as Tokens.Image).text || 'image'}]`, italic: true }];
		case 'html':
			return /^<br\s*\/?>$/i.test(t.text.trim()) ? [{ text: '', br: true }] : [];
		case 'checkbox':
			return [];
		default:
			return textRuns(t, style);
	}
}

/** Text, or a token that holds more inline tokens. */
function textRuns(t: Token, style: Style): Run[] {
	const nested = (t as { tokens?: Token[] }).tokens;
	if (nested && nested.length > 0) return runs(nested, style);
	return 'text' in t && typeof t.text === 'string' && t.text
		? [{ ...style, text: decodeEntities(t.text) }]
		: [];
}

/** The plain text of runs, for a title. */
export function runText(runs: Run[]): string {
	return runs.map((r) => (r.br ? ' ' : r.text)).join('');
}

/** Every picture the tree places, in order. */
export function modelImages(tree: Block[]): string[] {
	const out: string[] = [];
	const walk = (list: Block[]) => {
		for (const b of list) {
			if (b.kind === 'image') out.push(b.path);
			else if (b.kind === 'quote') walk(b.blocks);
			else if (b.kind === 'list') for (const item of b.items) walk(item.blocks);
		}
	};
	walk(tree);
	return out;
}
