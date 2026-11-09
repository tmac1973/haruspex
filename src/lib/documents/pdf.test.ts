import { describe, it, expect, vi } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Node, NodeQueries } from 'pdfmake/interfaces';
import { buildPdf, DEFAULT_OPTIONS, strandedHeading, tocLevels } from './pdf';
import { lex } from './content';
import { base64ToBytes } from '#lib/utils/base64.ts';
import type { SlideImage } from '#lib/slides/types.ts';

const ascii = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);
const noConvert = async (i: SlideImage) => i;

describe('buildPdf', () => {
	it('builds a one-page PDF and counts it', async () => {
		const pdf = await buildPdf('# Report\n\nOne line.', new Map(), noConvert);
		expect(ascii(pdf.bytes.slice(0, 5))).toBe('%PDF-');
		expect(pdf.pages).toBe(1);
		expect(pdf.missing.size).toBe(0);
	});

	it('flows a long document over pages and counts them', async () => {
		const body = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of the report.`);
		const pdf = await buildPdf(body.join('\n\n'), new Map(), noConvert);
		expect(pdf.pages).toBeGreaterThan(2);
	});

	it('never ends a page on a heading (the preview caught one at the foot of page 2)', async () => {
		// Paragraphs of every length from 4 to 12 sentences: some heading lands at a foot.
		const sentence = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod. ';
		let md = '# Title\n\nIntro.\n';
		for (let i = 1; i <= 18; i++) md += `\n## Section ${i}\n\n${sentence.repeat(4 + (i % 9))}\n`;
		const pdf = await buildPdf(md, new Map(), noConvert);
		const task = pdfjs.getDocument({ data: pdf.bytes.slice() });
		const doc = await task.promise;
		for (let n = 1; n <= doc.numPages; n++) {
			const items = (await (await doc.getPage(n)).getTextContent()).items as { str: string }[];
			const lines = items.map((i) => i.str.trim()).filter((s) => s && !/^\d+ \/ \d+$/.test(s));
			expect(lines.at(-1), `page ${n}`).not.toMatch(/^Section \d+$/);
		}
		await task.destroy();
	});

	it('carries a heading over with a table that moves to the next page', async () => {
		// Found in a sample: the table went over and left "Savings" behind.
		const long =
			'Heat pumps move heat rather than make it, so a unit can deliver three units of heat for one of electricity. '.repeat(
				14
			);
		const md =
			`# Heat Pumps\n\nA short look at costs and savings.\n\n## Costs\n\n${long}\n\n` +
			`### Install\n\n${long}\n\n## Savings\n\n` +
			`| Year | Saving |\n|---|---|\n| 1 | 420 |\n| 2 | 440 |\n\n${long}\n\n## Verdict\n\n${long}`;
		const opts = { ...DEFAULT_OPTIONS, pageSize: 'a4' as const, style: 'report' as const };
		const pdf = await buildPdf(md, new Map(), noConvert, {
			...opts,
			title: 'Heat Pumps',
			toc: true
		});
		for (let n = 1; n <= pdf.pages; n++) {
			// Not the page number or the running title, which are drawn after the page.
			const lines = (await pageText(pdf.bytes, n)).filter(
				(s) => !/^\d+ \/ \d+$/.test(s) && s !== 'Heat Pumps'
			);
			expect(lines.at(-1), `page ${n}`).not.toMatch(/^(Costs|Install|Savings|Year)$/);
		}
	});

	it('titles the PDF after its first heading', async () => {
		const pdf = await buildPdf('Intro.\n\n## Heat **Pumps**', new Map(), noConvert);
		expect(ascii(pdf.bytes)).toContain('(Heat Pumps)');
	});

	it('sets the page size', async () => {
		const size = async (pageSize: 'a4' | 'letter') => {
			const pdf = await buildPdf('Text.', new Map(), noConvert, { ...DEFAULT_OPTIONS, pageSize });
			return ascii(pdf.bytes)
				.match(/\/MediaBox \[([^\]]+)\]/)![1]
				.trim()
				.split(/\s+/)
				.map(Number);
		};
		expect((await size('a4')).map(Math.round)).toEqual([0, 0, 595, 842]);
		expect(await size('letter')).toEqual([0, 0, 612, 792]);
	});

	it('prints a title once, in place of an opening heading that repeats it', async () => {
		const opts = { ...DEFAULT_OPTIONS, style: 'report' as const, title: 'Heat Pumps' };
		const pdf = await buildPdf('# Heat pumps\n\nIntro.', new Map(), noConvert, opts);
		expect(await pageText(pdf.bytes, 1)).toEqual(['Heat Pumps', 'Intro.']);
		expect(ascii(pdf.bytes)).toContain('(Heat Pumps)');
	});

	it('lists the sections with their pages on a contents page', async () => {
		const long = 'Words of the section. '.repeat(160);
		const md = `# Report\n\n## Costs\n\n${long}\n\n## Savings\n\n${long}`;
		const pdf = await buildPdf(md, new Map(), noConvert, { ...DEFAULT_OPTIONS, toc: true });
		const contents = (await pageText(pdf.bytes, 1)).join(' ');
		expect(contents).toMatch(/Contents Costs 2 Savings \d/);
		expect(contents).not.toContain('Report');
	});

	it('leaves the page number off the first page of a letter', async () => {
		const md = 'Dear Sam,\n\n' + 'A line of the letter. '.repeat(400);
		const opts = { ...DEFAULT_OPTIONS, style: 'letter' as const };
		const pdf = await buildPdf(md, new Map(), noConvert, opts);
		expect(pdf.pages).toBeGreaterThan(1);
		expect((await pageText(pdf.bytes, 1)).some((s) => /^\d+ \/ \d+$/.test(s))).toBe(false);
		expect(await pageText(pdf.bytes, 2)).toContain(`2 / ${pdf.pages}`);
	});

	it('reports the characters the fonts lack', async () => {
		const pdf = await buildPdf('Ελλάδα 漢 🚀', new Map(), noConvert);
		expect([...pdf.missing]).toEqual(['漢', '🚀']);
	});

	it('embeds a PNG, and turns a GIF into one first', async () => {
		// One white pixel.
		const bytes = base64ToBytes(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'
		);
		const png: SlideImage = { mime: 'image/png', bytes, width: 1, height: 1 };
		const gif: SlideImage = { ...png, mime: 'image/gif' };
		const convert = vi.fn(async () => png);
		const pdf = await buildPdf(
			'![a](a.png)\n\n![b](b.gif)',
			new Map([
				['a.png', png],
				['b.gif', gif]
			]),
			convert
		);
		expect(convert).toHaveBeenCalledWith(gif);
		expect(ascii(pdf.bytes)).toContain('/Subtype /Image');
	});
});

describe('tocLevels', () => {
	it('lists the top two levels', () => {
		expect(tocLevels(lex('# A\n\n# B\n\n## C'))).toEqual([1, 2]);
	});

	it('goes below a lone top heading, the title', () => {
		expect(tocLevels(lex('# Title\n\n## A\n\n### B\n\n## C'))).toEqual([2, 3]);
	});
});

/** The text on page `n`, line by line. */
async function pageText(bytes: Uint8Array, n: number): Promise<string[]> {
	const task = pdfjs.getDocument({ data: bytes.slice() });
	const doc = await task.promise;
	const items = (await (await doc.getPage(n)).getTextContent()).items as { str: string }[];
	await task.destroy();
	return items.map((i) => i.str.trim()).filter(Boolean);
}

describe('strandedHeading', () => {
	const queries = (following: Node[]): NodeQueries => ({
		getFollowingNodesOnPage: () => following,
		getNodesOnNextPage: () => [],
		getPreviousNodesOnPage: () => []
	});
	/** Only the fields the rule reads. */
	const node = (fields: Partial<Node>) => ({ pageNumbers: [2], ...fields }) as Node;
	/** A heading on page 2 with `room` points of the page left below its top. */
	const headingAt = (room: number) =>
		node({
			headlineLevel: 2,
			startPosition: {
				pageNumber: 2,
				pageInnerHeight: 700,
				verticalRatio: 1 - room / 700
			} as Node['startPosition']
		});
	const heading = headingAt(400);

	it('moves a heading with only the page number or running title after it', () => {
		const furniture = [node({ style: 'header' }), node({ style: 'footer' })];
		expect(strandedHeading(heading, queries(furniture))).toBe(true);
		expect(strandedHeading(heading, queries([]))).toBe(true);
	});

	it('moves a heading followed only by another heading', () => {
		expect(
			strandedHeading(heading, queries([node({ headlineLevel: 3 }), node({ style: 'footer' })]))
		).toBe(true);
	});

	it('moves a heading in the last lines of a page when what it heads runs on', () => {
		const table = node({ table: { body: [] }, pageNumbers: [2, 3] });
		expect(strandedHeading(headingAt(80), queries([table]))).toBe(true);
		expect(strandedHeading(headingAt(200), queries([table]))).toBe(false);
	});

	it('leaves a heading in the last lines when what it heads ends on the page', () => {
		expect(strandedHeading(headingAt(80), queries([node({ style: 'p' })]))).toBe(false);
	});

	it('leaves a heading with its text after it, and anything that is not a heading', () => {
		expect(
			strandedHeading(heading, queries([node({ style: 'p' }), node({ style: 'footer' })]))
		).toBe(false);
		expect(strandedHeading(node({ style: 'p' }), queries([]))).toBe(false);
	});
});
