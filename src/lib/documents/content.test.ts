import { describe, it, expect } from 'vitest';
import {
	blocks,
	decodeEntities,
	imageOptions,
	imagePaths,
	lex,
	type ContentContext
} from './content';

/** A context whose fonts draw everything but `漢`. */
function context(images: ContentContext['images'] = new Map()): ContentContext {
	return {
		images,
		body: [0, 0x6f21, 0x6f23, 0x10ffff],
		mono: 'winansi',
		missing: new Set(),
		width: 500,
		height: 680,
		// Half an em a character: a word of 16 is 80 pt at the table's 10 pt.
		measure: { regular: half, bold: half },
		landscapeWidth: 680,
		pageName: 'a Letter',
		landscaped: []
	};
}

const half = (text: string, size: number) => text.length * size * 0.5;

/** A markdown table of `columns` columns, every cell a `chars`-letter word. */
function wideTable(columns: number, chars: number): string {
	const row = (fill: string) =>
		'| ' +
		Array.from({ length: columns }, (_, c) => fill + String(c).padStart(2, '0')).join(' | ') +
		' |';
	const word = 'x'.repeat(chars - 2);
	return [row(word.toUpperCase()), '|' + ' --- |'.repeat(columns), row(word)].join('\n');
}

// pdfmake content is loosely typed; the tests read it as plain objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function render(markdown: string, ctx = context()): Any[] {
	return blocks(lex(markdown), ctx) as Any[];
}

const texts = (runs: Any[]) => runs.map((r) => r.text).join('');

describe('inline text', () => {
	it('keeps bold, italic, code and links as runs', () => {
		const [p] = render('A **b** *i* `c` [l](https://x.org) ~~d~~');
		expect(p.text).toEqual([
			{ text: 'A ' },
			{ text: 'b', bold: true },
			{ text: ' ' },
			{ text: 'i', italics: true },
			{ text: ' ' },
			expect.objectContaining({ text: 'c', font: 'Courier' }),
			{ text: ' ' },
			expect.objectContaining({ text: 'l', link: 'https://x.org', decoration: 'underline' }),
			{ text: ' ' },
			{ text: 'd', decoration: 'lineThrough' }
		]);
	});

	it('does not link a path a reader cannot follow from a PDF', () => {
		const [p] = render('[notes](notes.md)');
		expect(p.text[0]).toEqual({ text: 'notes' });
	});

	it('prints entities as their characters', () => {
		expect(texts(render('Fish &amp; chips &lt;3 &#8364;5')[0].text)).toBe('Fish & chips <3 €5');
		expect(decodeEntities('&bogus; &#xZZ;')).toBe('&bogus; &#xZZ;');
	});

	it('breaks a line at <br>', () => {
		expect(texts(render('one<br>two')[0].text)).toBe('one\ntwo');
	});

	it('leaves out what the fonts cannot draw, and remembers it', () => {
		const ctx = context();
		expect(texts(render('a 漢 b', ctx)[0].text)).toBe('a  b');
		expect([...ctx.missing]).toEqual(['漢']);
	});
});

describe('blocks', () => {
	it('gives headings a style and a level, for keeping them with what follows', () => {
		const [h1, h3, h6] = render('# One\n\n### Three\n\n###### Six');
		expect(h1).toMatchObject({ style: 'h1', headlineLevel: 1 });
		expect(h1.text[0]).toMatchObject({ text: 'One', bold: true });
		expect(h3).toMatchObject({ style: 'h3', headlineLevel: 3 });
		expect(h6).toMatchObject({ style: 'h4', headlineLevel: 6 });
	});

	it('nests lists and numbers ordered ones from their start', () => {
		const [ol] = render('3. a\n4. b\n   - inner\n     - deeper');
		expect(ol.start).toBe(3);
		expect(ol.ol[0].text[0].text).toBe('a');
		const [, inner] = ol.ol[1].stack;
		expect(inner.margin).toEqual([0, 0, 0, 0]);
		expect(inner.ul[0].stack[1].ul[0].text[0].text).toBe('deeper');
	});

	it('marks task items', () => {
		const [ul] = render('- [x] done\n- [ ] todo');
		expect(texts(ul.ul[0].text)).toBe('[x] done');
		expect(texts(ul.ul[1].text)).toBe('[ ] todo');
	});

	it('draws a code block in Courier, spaces kept, boxes made ASCII', () => {
		const [code] = render('```\nroot\n├── a\n\tb\n```');
		const cell = code.table.body[0][0];
		expect(cell).toMatchObject({ font: 'Courier', preserveLeadingSpaces: true });
		expect(cell.text).toBe('root\n+-- a\n    b');
	});

	it('draws a quote beside a rule, its own blocks inside', () => {
		const [quote] = render('> **Note.** It works.');
		expect(quote.table.body[0][0].stack[0].text[0]).toMatchObject({ text: 'Note.', bold: true });
	});

	it('draws a rule across the page', () => {
		const [hr] = render('---');
		expect(hr.canvas[0]).toMatchObject({ type: 'line', x2: 500 });
	});

	it('prints block HTML as its text', () => {
		expect(texts(render('<div>Hello <b>there</b></div>')[0].text)).toBe('Hello there');
	});
});

describe('tables', () => {
	const md = [
		'| Model | Price | Notes |',
		'|---|---|:-:|',
		'| Alpha | $4,200 | A long remark about how the unit sounded at night |',
		'| **Beta** | 3.5% | Short |'
	].join('\n');

	it('repeats the header, and puts a number column on the right', () => {
		const [t] = render(md);
		expect(t.table.headerRows).toBe(1);
		expect(t.table.keepWithHeaderRows).toBe(1);
		expect(t.table.body[0][0].text[0]).toMatchObject({ text: 'Model', bold: true });
		expect(t.table.body.map((r: Any[]) => r[1].alignment)).toEqual(['right', 'right', 'right']);
		expect(t.table.body[1][0].alignment).toBe('left');
		// The markdown's own alignment wins.
		expect(t.table.body[1][2].alignment).toBe('center');
		expect(t.table.body[2][0].text[0]).toMatchObject({ text: 'Beta', bold: true });
	});

	it('gives a long column the room and sizes short ones to fit', () => {
		expect(render(md)[0].table.widths).toEqual(['auto', 'auto', '*']);
		expect(render('| a | b |\n|---|---|\n| 1 | 22 |')[0].table.widths).toEqual(['auto', '*']);
	});

	it('fills a short row', () => {
		const [t] = render('| a | b |\n|---|---|\n| 1 |');
		expect(t.table.body[1]).toHaveLength(2);
	});
});

describe('pictures', () => {
	const img = { dataUrl: 'data:image/png;base64,AA', width: 800, height: 400 };

	it('lists the pictures that stand on their own lines', () => {
		const tokens = lex('![a](a.png)\n![b](b.png)\n\nText ![c](c.png) inline.\n\n- ![d](d.png)');
		expect(imagePaths(tokens)).toEqual(['a.png', 'b.png', 'd.png']);
	});

	it('places one at its natural size, no wider than the page', () => {
		const [p] = render('![a](a.png)', context(new Map([['a.png', img]])));
		// 800 px at 96 dpi is 600 pt: wider than the 500 pt page.
		expect(p).toMatchObject({ image: img.dataUrl, width: 500, alignment: 'left' });
	});

	it('takes alignment and width from the title', () => {
		const [p] = render('![a](a.png "center 50%")', context(new Map([['a.png', img]])));
		expect(p).toMatchObject({ width: 250, alignment: 'center' });
	});

	it('keeps a tall picture within the page', () => {
		const tall = { ...img, width: 400, height: 2000 };
		const [p] = render('![a](a.png)', context(new Map([['a.png', tall]])));
		expect(p.width).toBeCloseTo((680 * 0.85 * 400) / 2000);
	});

	it('places a picture that is a list item on its own', () => {
		const [ul] = render('- ![a](a.png)', context(new Map([['a.png', img]])));
		expect(ul.ul[0]).toMatchObject({ image: img.dataUrl });
	});

	it('prints a picture inside a sentence as its alt text', () => {
		const [p] = render('See ![the chart](c.png) here.');
		expect(texts(p.text)).toBe('See [the chart] here.');
	});

	it('reads options as the other writers do', () => {
		expect(imageOptions('centre 150%')).toEqual({ alignment: 'center', fraction: 1 });
		expect(imageOptions('right 2%')).toEqual({ alignment: 'right', fraction: 0.05 });
		expect(imageOptions(null)).toEqual({ alignment: 'left', fraction: undefined });
	});
});

describe('a table wider than the page', () => {
	it('stays on the page when its columns fit', () => {
		const [table] = blocks(lex(wideTable(5, 16)), context()) as Any[];
		expect(table.pageOrientation).toBeUndefined();
		expect(table.pageBreak).toBeUndefined();
	});

	it('goes on a landscape page with its heading, and the page after turns back', () => {
		// Six columns of 80 pt words and 12 pt padding: 552 pt, over 500 and under 680.
		const ctx = context();
		const out = blocks(lex(`Intro.\n\n## Sales\n\n${wideTable(6, 16)}\n\nAfter.`), ctx) as Any[];
		expect(out.map((n) => [n.pageBreak, n.pageOrientation])).toEqual([
			[undefined, undefined],
			['before', 'landscape'],
			[undefined, 'landscape'],
			['before', 'portrait']
		]);
		expect(ctx.landscaped).toEqual(['XXXXXXXXXXXXXX00, XXXXXXXXXXXXXX01, XXXXXXXXXXXXXX02, …']);
	});

	it('starts the landscape page itself with no heading before it', () => {
		const out = blocks(lex(`Intro.\n\n${wideTable(6, 16)}`), context()) as Any[];
		expect([out[1].pageBreak, out[1].pageOrientation]).toEqual(['before', 'landscape']);
	});

	it('is refused with a budget when it is too wide for landscape too', () => {
		// Eight columns: 736 pt, over 680, so about seven fit.
		expect(() => blocks(lex(wideTable(8, 16)), context())).toThrow(
			/its 8 columns need about 736 pt at their narrowest, and a Letter page turned sideways has 680 pt\. About 7 columns fit\./
		);
	});
});
