import { describe, it, expect, vi } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Node, NodeQueries } from 'pdfmake/interfaces';
import { buildPdf, strandedHeading } from './pdf';
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

	it('titles the PDF after its first heading', async () => {
		const pdf = await buildPdf('Intro.\n\n## Heat **Pumps**', new Map(), noConvert);
		expect(ascii(pdf.bytes)).toContain('(Heat Pumps)');
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

describe('strandedHeading', () => {
	const queries = (following: Node[]): NodeQueries => ({
		getFollowingNodesOnPage: () => following,
		getNodesOnNextPage: () => [],
		getPreviousNodesOnPage: () => []
	});
	/** Only the fields the rule reads. */
	const node = (fields: Partial<Node>) => fields as Node;
	const heading = node({ headlineLevel: 2 });

	it('moves a heading with only the page number after it', () => {
		expect(strandedHeading(heading, queries([node({ style: 'footer' })]))).toBe(true);
		expect(strandedHeading(heading, queries([]))).toBe(true);
	});

	it('moves a heading followed only by another heading', () => {
		expect(
			strandedHeading(heading, queries([node({ headlineLevel: 3 }), node({ style: 'footer' })]))
		).toBe(true);
	});

	it('leaves a heading with its text after it, and anything that is not a heading', () => {
		expect(
			strandedHeading(heading, queries([node({ style: 'p' }), node({ style: 'footer' })]))
		).toBe(false);
		expect(strandedHeading(node({ style: 'p' }), queries([]))).toBe(false);
	});
});
