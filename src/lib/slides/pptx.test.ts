import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildPptx } from './pptx';
import { DeckFitError } from './textfit';
import { pngHeader } from './testImages';
import type { SlideTheme } from './themes';
import type { Slide, SlideImage, SlideOrientation } from './types';

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
			const text = boxes(xml.slice(0, xml.indexOf('<p:pic>')));
			const bullets = text[text.length - 1];
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
