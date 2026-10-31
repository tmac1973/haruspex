import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildPptx } from './pptx';
import { DeckFitError } from './textfit';
import { pngHeader } from './testImages';
import type { SlideTheme } from './themes';
import type { Slide, SlideChart, SlideImage, SlideOrientation } from './types';

// The deck PptxGenJS writes, read back as XML: order, bullet levels,
// escaping, the page shape for each orientation, and what each layout and
// theme draws.

const EMU = 914400;

async function build(
	slides: Slide[],
	orientation: SlideOrientation = 'landscape',
	images = new Map<string, SlideImage>(),
	theme: SlideTheme = 'light'
): Promise<JSZip> {
	return JSZip.loadAsync(await buildPptx(slides, orientation, images, theme));
}

async function part(zip: JSZip, name: string): Promise<string> {
	const file = zip.file(name);
	if (!file) throw new Error(`missing ${name}`);
	return file.async('string');
}

async function slideXml(slides: Slide[], orientation?: SlideOrientation): Promise<string> {
	return part(await build(slides, orientation), 'ppt/slides/slide1.xml');
}

/** The `<a:t>` run texts of a slide, in order, less the slide number field. */
const runs = (xml: string) =>
	[...xml.replace(/<a:fld[^>]*>.*?<\/a:fld>/g, '').matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(
		(m) => m[1]
	);

/** The font size, in points, of the run holding `text`. */
function sizeOf(xml: string, text: string): number {
	const m = new RegExp(`<a:rPr[^>]*sz="(\\d+)"[^>]*>(?:(?!</a:r>).)*<a:t>${text}<`).exec(xml);
	if (!m) throw new Error(`no sized run for ${text}`);
	return Number(m[1]) / 100;
}

/** The `lvl` of each bulleted paragraph, in order; absent means level 0. */
const levels = (xml: string) =>
	[...xml.matchAll(/<a:pPr([^>]*)>(?:(?!<\/a:pPr>).)*<a:buChar/g)].map(
		(m) => /lvl="(\d)"/.exec(m[1])?.[1] ?? '0'
	);

/** Each `<a:off>`/`<a:ext>` pair on a slide, in inches. */
const boxes = (xml: string) =>
	[...xml.matchAll(/<a:off x="(\d+)" y="(\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/g)]
		.map((m) => m.slice(1).map((v) => Number(v) / EMU))
		.filter(([, , w]) => w > 0)
		.map(([x, y, w, h]) => ({ x, y, w, h }));

/** The box of the shape whose text is `text`. */
function boxOf(xml: string, text: string) {
	const shape = xml.split('<p:sp>').find((s) => s.includes(`<a:t>${text}</a:t>`));
	if (!shape) throw new Error(`no shape holds ${text}`);
	return boxes(shape)[0];
}

function image(width: number, height: number): SlideImage {
	return { mime: 'image/png', bytes: pngHeader(width, height), width, height };
}

describe('the page', () => {
	// PowerPoint's widescreen page, exactly: 12192000 × 6858000 EMU.
	it('is 13⅓ × 7.5 in landscape', async () => {
		const pres = await part(await build([{ title: 'A' }]), 'ppt/presentation.xml');
		expect(pres).toContain('<p:sldSz cx="12192000" cy="6858000"');
	});

	it('is 7.5 × 13⅓ in portrait', async () => {
		const pres = await part(await build([{ title: 'A' }], 'portrait'), 'ppt/presentation.xml');
		expect(pres).toContain('<p:sldSz cx="6858000" cy="12192000"');
	});
});

describe('slides', () => {
	it('keep their order, one part each', async () => {
		const zip = await build([
			{ title: 'One', bullets: ['a'] },
			{ title: 'Two', layout: 'section' },
			{ title: 'Three', bullets: ['c'] }
		]);
		for (const [i, title] of ['One', 'Two', 'Three'].entries()) {
			expect(runs(await part(zip, `ppt/slides/slide${i + 1}.xml`))[0]).toBe(title);
		}
		expect(zip.file('ppt/slides/slide4.xml')).toBeNull();
	});

	it('refuse an empty deck', async () => {
		await expect(buildPptx([], 'landscape', new Map())).rejects.toThrow(
			'At least one slide is required'
		);
	});
});

describe('bullets', () => {
	it('keep their order, are trimmed, and clamp levels past two', async () => {
		const zip = await build([
			{
				title: '  Padded title  ',
				bullets: ['first', { text: '  child  ', level: 1 }, { text: 'deep', level: 7 }, 'back']
			}
		]);
		const xml = await part(zip, 'ppt/slides/slide1.xml');
		expect(runs(xml)).toEqual(['Padded title', 'first', 'child', 'deep', 'back']);
		expect(levels(xml)).toEqual(['0', '1', '2', '0']);
	});

	it('shrink with their level', async () => {
		const xml = await slideXml([
			{ title: 'T', bullets: ['a', { text: 'b', level: 1 }, { text: 'c', level: 2 }] }
		]);
		expect(['a', 'b', 'c'].map((t) => sizeOf(xml, t))).toEqual([22, 19, 17]);
	});

	it('shrink a step to fit a crowded slide', async () => {
		const sentence = 'A bullet of about seventy characters, which is one line on this slide';
		const xml = await slideXml([{ title: 'T', bullets: Array(10).fill(sentence) }]);
		const size = sizeOf(xml, sentence);
		expect(size).toBeLessThan(22);
		expect(size).toBeGreaterThanOrEqual(22 * 0.7 - 0.5);
	});

	it('draw **bold** as a bold run in the same paragraph', async () => {
		const xml = await slideXml([
			{ title: 'T', bullets: ['**Habitat loss** - clearing', { text: 'x **y**', level: 1 }, 'z'] }
		]);
		expect(runs(xml)).toEqual(['T', 'Habitat loss', ' - clearing', 'x ', 'y', 'z']);
		expect(levels(xml)).toEqual(['0', '1', '0']);
		// One set of paragraph properties, before the first run: one after a
		// run would turn the bullet off.
		expect(xml).not.toMatch(/<\/a:r><a:pPr/);
		expect(xml).toMatch(/<a:rPr[^>]*\bb="1"[^>]*>(?:(?!<\/a:r>).)*<a:t>Habitat loss</);
		expect(xml).not.toMatch(/<a:rPr[^>]*\bb="1"[^>]*>(?:(?!<\/a:r>).)*<a:t> - clearing</);
	});

	it('are left out when there are none', async () => {
		const xml = await part(await build([{ title: 'Empty', bullets: [] }]), 'ppt/slides/slide1.xml');
		expect(runs(xml)).toEqual(['Empty']);
	});
});

describe('section slides', () => {
	it('show the subtitle, and leave out a blank one', async () => {
		const zip = await build([
			{ title: 'Part', layout: 'section', subtitle: '  Tag  ' },
			{ title: 'Part', layout: 'section', subtitle: '   ' },
			{ title: 'Part', layout: 'section', bullets: ['dropped'] }
		]);
		expect(runs(await part(zip, 'ppt/slides/slide1.xml'))).toEqual(['Part', 'Tag']);
		expect(runs(await part(zip, 'ppt/slides/slide2.xml'))).toEqual(['Part']);
		expect(runs(await part(zip, 'ppt/slides/slide3.xml'))).toEqual(['Part']);
	});

	it('leave a content slide’s subtitle out', async () => {
		const xml = await part(
			await build([{ title: 'Body', subtitle: 'unused', bullets: ['point'] }]),
			'ppt/slides/slide1.xml'
		);
		expect(runs(xml)).toEqual(['Body', 'point']);
	});
});

it('escapes text', async () => {
	const xml = await part(
		await build([{ title: 'R&D <2026>', bullets: ['1 < 2', 'He said "hi"'] }]),
		'ppt/slides/slide1.xml'
	);
	expect(xml).toContain('R&amp;D &lt;2026&gt;');
	expect(xml).toContain('1 &lt; 2');
	expect(xml).not.toContain('R&D <2026>');
});

describe('images', () => {
	it('embed the bytes and keep the picture’s shape', async () => {
		const images = new Map([['wide.png', image(1600, 400)]]);
		const zip = await build(
			[{ title: 'T', bullets: ['x'], image: 'wide.png' }],
			'landscape',
			images
		);
		const media = Object.keys(zip.files).filter(
			(n) => n.startsWith('ppt/media/') && !zip.files[n].dir
		);
		expect(media).toHaveLength(1);
		expect(new Uint8Array(await zip.file(media[0])!.async('uint8array'))).toEqual(
			pngHeader(1600, 400)
		);
		const xml = await part(zip, 'ppt/slides/slide1.xml');
		const pic = xml.slice(xml.indexOf('<p:pic>'));
		const [box] = boxes(pic);
		expect(box.w / box.h).toBeCloseTo(4, 1);
	});

	it('sit beside the bullets in landscape and above them in portrait', async () => {
		const images = new Map([['sq.png', image(500, 500)]]);
		const slide: Slide = { title: 'T', bullets: ['x'], image: 'sq.png' };
		for (const orientation of ['landscape', 'portrait'] as const) {
			const xml = await part(await build([slide], orientation, images), 'ppt/slides/slide1.xml');
			const pic = boxes(xml.slice(xml.indexOf('<p:pic>')))[0];
			const bullets = boxOf(xml, 'x');
			if (orientation === 'landscape') expect(pic.x).toBeGreaterThan(bullets.x + bullets.w);
			else expect(pic.y + pic.h).toBeLessThan(bullets.y);
		}
	});

	it('are an error when the caller did not load them', async () => {
		await expect(
			buildPptx([{ title: 'T', image: 'gone.png' }], 'landscape', new Map())
		).rejects.toThrow('Image not loaded: gone.png');
	});
});

describe('text that will not fit', () => {
	const many = Array.from({ length: 30 }, (_, i) => `Point number ${i} with a few more words`);

	it('refuses the deck, naming each crowded slide', async () => {
		const err = await buildPptx(
			[
				{ title: 'Fine', bullets: ['ok'] },
				{ title: 'Crowded', bullets: many },
				{ title: 'Columns', layout: 'two-column', bullets: ['ok'], right: many }
			],
			'landscape',
			new Map()
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DeckFitError);
		const { problems, message } = err as DeckFitError;
		expect(problems).toHaveLength(2);
		expect(problems[0]).toMatch(/^Slide 2 \("Crowded"\): the bullets need about \d+\.\d× the room/);
		expect(problems[1]).toMatch(/^Slide 3 \("Columns"\): the right column need/);
		expect(message).toMatch(/^The deck was not written: /);
		expect(message).toMatch(/Split crowded slides into two/);
	});

	it('shrinks both columns to the size the fuller one needs', async () => {
		const sentence = 'A bullet of about seventy characters, which is one line or two here';
		const xml = await slideXml([
			{ title: 'T', layout: 'two-column', bullets: Array(7).fill(sentence), right: ['short'] }
		]);
		expect(sizeOf(xml, sentence)).toBeLessThan(22);
		expect(sizeOf(xml, 'short')).toBe(sizeOf(xml, sentence));
	});

	it('names the column by where it sits in portrait', async () => {
		const err = (await buildPptx(
			[{ title: 'Columns', layout: 'two-column', bullets: many, right: ['ok'] }],
			'portrait',
			new Map()
		).catch((e: unknown) => e)) as DeckFitError;
		expect(err.problems[0]).toMatch(/the top column need/);
	});
});

describe('themes', () => {
	const fill = (xml: string) => /<p:bg>.*?srgbClr val="([0-9A-F]{6})"/.exec(xml)?.[1];

	it.each([
		['light', 'FFFFFF'],
		['dark', '111827'],
		['warm', 'FBF7F0']
	] as const)('%s paints the background %s', async (theme, color) => {
		const zip = await build([{ title: 'T', bullets: ['a'] }], 'landscape', new Map(), theme);
		expect(fill(await part(zip, 'ppt/slides/slide1.xml'))).toBe(color);
	});

	it('sets the theme’s fonts', async () => {
		const zip = await build(
			[{ title: 'Title', bullets: ['body'] }],
			'landscape',
			new Map(),
			'warm'
		);
		const xml = await part(zip, 'ppt/slides/slide1.xml');
		expect(xml).toMatch(/typeface="Georgia"[^]*?<a:t>Title</);
		expect(xml).toMatch(/typeface="Calibri"[^]*?<a:t>body</);
	});

	it('gives a cover the band colour', async () => {
		const zip = await build([{ title: 'Deck', layout: 'cover' }], 'landscape', new Map(), 'calm');
		expect(fill(await part(zip, 'ppt/slides/slide1.xml'))).toBe('134E4A');
	});
});

describe('layouts', () => {
	it('cover: the title and subtitle, no slide number', async () => {
		const xml = await slideXml([{ title: 'Q3 review', layout: 'cover', subtitle: 'The numbers' }]);
		expect(runs(xml)).toEqual(['Q3 review', 'The numbers']);
		expect(xml).not.toContain('type="slidenum"');
	});

	it('content: a slide number', async () => {
		expect(await slideXml([{ title: 'T', bullets: ['a'] }])).toContain('type="slidenum"');
	});

	it('two-column: side by side in landscape, stacked in portrait', async () => {
		const slide: Slide = { title: 'T', layout: 'two-column', bullets: ['left'], right: ['right'] };
		for (const orientation of ['landscape', 'portrait'] as const) {
			const xml = await slideXml([slide], orientation);
			expect(runs(xml)).toEqual(['T', 'left', 'right']);
			const [left, right] = [boxOf(xml, 'left'), boxOf(xml, 'right')];
			if (orientation === 'landscape') expect(right.x).toBeGreaterThan(left.x + left.w);
			else expect(right.y).toBeGreaterThan(left.y + left.h);
		}
	});

	it('quote: an opening mark, the quote, and a dash before the speaker', async () => {
		const xml = await slideXml([{ title: 'Ship it.', layout: 'quote', subtitle: 'Ada' }]);
		expect(runs(xml)).toEqual(['“', 'Ship it.', '— Ada']);
		const dashed = await slideXml([{ title: 'Q', layout: 'quote', subtitle: '— Ada' }]);
		expect(runs(dashed)).toEqual(['“', 'Q', '— Ada']);
	});

	it('stat: the number large, then what it means', async () => {
		const xml = await slideXml([{ title: '42%', layout: 'stat', subtitle: 'of tickets closed' }]);
		expect(runs(xml)).toEqual(['42%', 'of tickets closed']);
		expect(sizeOf(xml, '42%')).toBe(110);
	});

	it('image: the picture fills the page, cropped to keep its shape', async () => {
		const images = new Map([['wide.png', image(1600, 400)]]);
		const zip = await build(
			[{ title: 'View', layout: 'image', image: 'wide.png', subtitle: 'From the hill' }],
			'landscape',
			images
		);
		const xml = await part(zip, 'ppt/slides/slide1.xml');
		expect(runs(xml)).toEqual(['View', 'From the hill']);
		const pic = xml.slice(xml.indexOf('<p:pic>'), xml.indexOf('</p:pic>'));
		const [box] = boxes(pic);
		expect(box.x).toBeCloseTo(0);
		expect(box.y).toBeCloseTo(0);
		// To the edge: the page, exactly, not a hair short.
		expect(pic).toContain('<a:ext cx="12192000" cy="6858000"/>');
		// A 4:1 picture on a 16:9 page loses its sides, evenly.
		const crop = /<a:srcRect l="(\d+)" r="(\d+)" t="(\d+)" b="(\d+)"/.exec(pic);
		expect(crop).not.toBeNull();
		const [l, r, t, b] = crop!.slice(1).map(Number);
		expect(l).toBe(r);
		expect(l).toBeGreaterThan(0);
		expect(t + b).toBe(0);
	});
});

describe('speaker notes', () => {
	it('go in the slide’s notes page', async () => {
		const zip = await build([{ title: 'T', bullets: ['a'], notes: '  Say hello first.  ' }]);
		const notes = await part(zip, 'ppt/notesSlides/notesSlide1.xml');
		expect(notes).toContain('Say hello first.');
	});
});

describe('charts', () => {
	const sales: SlideChart = {
		type: 'bar',
		labels: ['Q1', 'Q2', 'Q3'],
		series: [{ name: 'Sales', values: [3, 5, 4] }]
	};

	async function chartXml(chart: SlideChart, theme: SlideTheme = 'light'): Promise<string> {
		const zip = await build([{ title: 'T', chart }], 'landscape', new Map(), theme);
		const name = Object.keys(zip.files).find((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
		if (!name) throw new Error('no chart part');
		return part(zip, name);
	}

	it.each([
		['bar', 'c:barChart'],
		['line', 'c:lineChart'],
		['pie', 'c:pieChart'],
		['doughnut', 'c:doughnutChart']
	] as const)('draws a %s chart', async (type, element) => {
		expect(await chartXml({ ...sales, type })).toContain(`<${element}>`);
	});

	it('carries the labels, series and values, so PowerPoint can edit them', async () => {
		const xml = await chartXml(sales);
		for (const text of ['Q1', 'Q2', 'Q3', 'Sales']) expect(xml).toContain(`<c:v>${text}</c:v>`);
		for (const v of ['3', '5', '4']) expect(xml).toContain(`<c:v>${v}</c:v>`);
		expect(xml).toContain('<c:barDir val="col"/>');
	});

	it('writes the value axis with thousands separators from 1,000 up', async () => {
		const axis = (xml: string) => /<c:valAx>.*?<c:numFmt formatCode="([^"]*)"/s.exec(xml)?.[1];
		const big = { ...sales, series: [{ name: 'Gorillas', values: [320000, 6800, 300] }] };
		expect(axis(await chartXml(big))).toBe('#,##0');
		expect(axis(await chartXml(sales))).toBe('General');
	});

	it('colours the series from the theme', async () => {
		expect(await chartXml(sales, 'warm')).toContain('srgbClr val="C2410C"');
	});

	it('fills the body when the slide has no bullets, and shares it when it does', async () => {
		const alone = await slideXml([{ title: 'T', chart: sales }]);
		const shared = await slideXml([{ title: 'T', bullets: ['Up'], chart: sales }]);
		const frame = (xml: string) => boxes(xml.slice(xml.indexOf('<p:graphicFrame')))[0];
		expect(frame(alone).w).toBeGreaterThan(frame(shared).w * 1.5);
	});
});

describe('tables', () => {
	const people = [
		['Name', 'Age', 'City'],
		['Ada', '36', 'London'],
		['Alan', '41', 'Wilmslow']
	];

	it('draws every cell, the header on the theme’s band', async () => {
		const xml = await slideXml([{ title: 'T', table: people }]);
		expect(xml).toContain('<a:tbl>');
		for (const cell of people.flat()) expect(xml).toContain(`<a:t>${cell}</a:t>`);
		const header = xml.slice(xml.indexOf('<a:tr'), xml.indexOf('</a:tr>'));
		expect(header).toContain('srgbClr val="1E3A8A"');
	});

	it('lines a column of numbers up on the right, its header with it', async () => {
		const table = [
			['Name', 'Age', 'Revenue', 'City'],
			['Ada', '36', '$4.2m', 'London'],
			['Alan', '41', '3bn', 'Wilmslow']
		];
		const xml = await slideXml([{ title: 'T', table }]);
		const cellWith = (text: string) => {
			const at = xml.indexOf(`<a:t>${text}</a:t>`);
			return xml.slice(xml.lastIndexOf('<a:tc', at), at);
		};
		for (const cell of ['Age', '36', 'Revenue', '$4.2m']) {
			expect(cellWith(cell), cell).toContain('algn="r"');
		}
		for (const cell of ['Name', 'City', 'London']) {
			expect(cellWith(cell), cell).not.toContain('algn="r"');
		}
	});

	it('puts portrait bullets just under a short table, not under its share', async () => {
		const xml = await slideXml(
			[{ title: 'T', bullets: ['After the table'], table: people }],
			'portrait'
		);
		const table = boxes(xml.slice(xml.indexOf('<p:graphicFrame')))[0];
		const bullets = boxOf(xml, 'After the table');
		const rows = 3 * ((14 * 1.2) / 72 + 0.1);
		expect(bullets.y).toBeCloseTo(table.y + rows + 0.5, 1);
	});

	it('shrinks to fit, and refuses a table far too tall for the slide', async () => {
		const row = (i: number) => [
			`Row ${i}`,
			'a longer cell that wraps onto more lines than one',
			'1'
		];
		const tall = [['A', 'B', 'C'], ...Array.from({ length: 24 }, (_, i) => row(i))];
		const err = (await buildPptx([{ title: 'Big', table: tall }], 'landscape', new Map()).catch(
			(e: unknown) => e
		)) as DeckFitError;
		expect(err).toBeInstanceOf(DeckFitError);
		expect(err.problems[0]).toMatch(/^Slide 1 \("Big"\): the table needs about \d+\.\d× the room/);

		// Thirteen one-line rows are taller than the body at 16pt.
		const medium = [['A', 'B', 'C'], ...Array.from({ length: 12 }, (_, i) => row(i))];
		const xml = await slideXml([{ title: 'T', table: medium }]);
		const sizes = [...xml.matchAll(/<a:rPr[^>]*sz="(\d+)"/g)].map((m) => Number(m[1]) / 100);
		expect(Math.min(...sizes)).toBeLessThan(16);
	});
});

describe('a picture with no bullets', () => {
	it('gets the whole body', async () => {
		const images = new Map([['sq.png', image(500, 500)]]);
		const alone = await part(
			await build([{ title: 'T', image: 'sq.png' }], 'landscape', images),
			'ppt/slides/slide1.xml'
		);
		const pic = boxes(alone.slice(alone.indexOf('<p:pic>')))[0];
		// Centred on the page, not pushed into the right half.
		expect(pic.x + pic.w / 2).toBeCloseTo(40 / 3 / 2, 1);
	});
});
