import { describe, it, expect, vi } from 'vitest';
import { buildPdf } from './pdf';
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
