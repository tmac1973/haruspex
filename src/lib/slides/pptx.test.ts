import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildPptx } from './pptx';
import { pngHeader } from './testImages';
import type { Slide, SlideImage, SlideOrientation } from './types';

// The deck PptxGenJS writes, read back as XML. These hold what the old Rust
// writer's tests held: order, bullet levels, escaping, section slides and
// images, plus the page shape for each orientation.

const EMU = 914400;

async function build(
	slides: Slide[],
	orientation: SlideOrientation = 'landscape',
	images = new Map<string, SlideImage>()
): Promise<JSZip> {
	return JSZip.loadAsync(await buildPptx(slides, orientation, images));
}

async function part(zip: JSZip, name: string): Promise<string> {
	const file = zip.file(name);
	if (!file) throw new Error(`missing ${name}`);
	return file.async('string');
}

/** The `<a:t>` run texts of a slide, in order. */
const runs = (xml: string) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);

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

function image(width: number, height: number): SlideImage {
	return { mime: 'image/png', bytes: pngHeader(width, height), width, height };
}

describe('the page', () => {
	it('is 13.333 × 7.5 in landscape', async () => {
		const pres = await part(await build([{ title: 'A' }]), 'ppt/presentation.xml');
		const [, cx, cy] = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(pres)!;
		expect(Number(cx) / EMU).toBeCloseTo(13.333, 2);
		expect(Number(cy) / EMU).toBeCloseTo(7.5, 2);
	});

	it('is 7.5 × 13.333 in portrait', async () => {
		const pres = await part(await build([{ title: 'A' }], 'portrait'), 'ppt/presentation.xml');
		const [, cx, cy] = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(pres)!;
		expect(Number(cx) / EMU).toBeCloseTo(7.5, 2);
		expect(Number(cy) / EMU).toBeCloseTo(13.333, 2);
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
		const xml = await part(
			await build([
				{ title: 'T', bullets: ['a', { text: 'b', level: 1 }, { text: 'c', level: 2 }] }
			]),
			'ppt/slides/slide1.xml'
		);
		const sizes = [
			...xml.matchAll(/<a:rPr[^>]*sz="(\d+)"[^>]*>(?:(?!<\/a:r>).)*<a:t>([abc])</g)
		].map((m) => [m[2], m[1]]);
		expect(sizes).toEqual([
			['a', '1800'],
			['b', '1600'],
			['c', '1400']
		]);
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
