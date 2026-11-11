import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { documentModel } from './model';
import { buildOdt } from './odt';
import { spaced } from './odtBody';
import type { DocumentOptions } from './looks';
import type { SlideImage } from '#lib/slides/types.ts';

const PLAIN: DocumentOptions = { pageSize: 'letter', style: 'plain', toc: false };
const png: SlideImage = {
	mime: 'image/png',
	bytes: new Uint8Array([137, 80, 78, 71]),
	width: 800,
	height: 400
};

async function build(markdown: string, options = PLAIN, images = new Map<string, SlideImage>()) {
	const bytes = await buildOdt(documentModel(markdown), images, options);
	const zip = await JSZip.loadAsync(bytes);
	const part = async (name: string) => (await zip.file(name)?.async('string')) ?? '';
	for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.xml'))) {
		const doc = new DOMParser().parseFromString(await part(name), 'application/xml');
		expect(doc.getElementsByTagName('parsererror'), name).toHaveLength(0);
	}
	return { bytes, zip, part, body: await part('content.xml'), styles: await part('styles.xml') };
}

describe('buildOdt', () => {
	it('puts the mimetype first and uncompressed, as LibreOffice requires', async () => {
		const { bytes } = await build('Text.');
		// One character a byte: the header's timestamp isn't UTF-8.
		const head = new TextDecoder('latin1').decode(bytes.slice(0, 80));
		expect(head.slice(30, 38)).toBe('mimetype');
		expect(head).toContain('application/vnd.oasis.opendocument.text');
		// Compression method 0: stored.
		expect(bytes[8] | (bytes[9] << 8)).toBe(0);
	});

	it('writes outline headings and styled runs', async () => {
		const { body } = await build('## Heat\n\nA **bold** ~~old~~ `code` [link](https://x.org).');
		expect(body).toContain(
			'<text:h text:style-name="Heading_20_2" text:outline-level="2">Heat</text:h>'
		);
		expect(body).toContain('<text:span text:style-name="T_b">bold</text:span>');
		expect(body).toContain('<style:style style:name="T_s" style:family="text">');
		expect(body).toContain('<text:span text:style-name="T_c">code</text:span>');
		expect(body).toContain('<text:a xlink:type="simple" xlink:href="https://x.org"');
	});

	it('writes lists by kind, a numbered one from its start', async () => {
		const { body } = await build('3. a\n4. b\n   - inner\n\n- [x] done\n- [ ] not');
		expect(body).toContain(
			'<text:list text:style-name="Numbering_20_123"><text:list-item text:start-value="3">'
		);
		expect(body).toContain('<text:list text:style-name="List_20_Bullet">');
		expect(body).toContain('<text:list text:style-name="Checklist">');
		expect(body).toContain('☒ done');
	});

	it('writes a table with a header row and aligned cells', async () => {
		const { body } = await build('| Item | Cost |\n|---|---|\n| Pump | 1,200 |');
		expect(body).toContain('<table:table-column table:style-name="Table1.C1"/>');
		expect(body).toContain('<table:table-column table:style-name="Table1.C2"/>');
		expect(body).toContain('<table:table-header-rows>');
		expect(body).toContain('text:style-name="Table_20_Contents_right">1,200');
	});

	it('gives a long word room instead of splitting the width evenly', async () => {
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];
		const md =
			`| Fruit | ${months.join(' | ')} |\n|${'---|'.repeat(9)}\n` +
			`| Strawberries | ${months.map(() => '3.50').join(' | ')} |`;
		const { body } = await build(md);
		const widths = [...body.matchAll(/style:column-width="([\d.]+)pt"/g)].map((m) => +m[1]);
		expect(widths).toHaveLength(9);
		expect(widths[0]).toBeGreaterThan(widths[1] * 1.8);
		// Strawberries at 10pt, with its padding.
		expect(widths[0]).toBeGreaterThan(70);
	});

	it('embeds a picture once, in the manifest, sized to the page', async () => {
		const md = '![Chart](c.png "right 50%")\n\n![Again](c.png)';
		const { zip, body, part } = await build(md, PLAIN, new Map([['c.png', png]]));
		expect(Object.keys(zip.files)).toContain('Pictures/image1.png');
		expect(await part('META-INF/manifest.xml')).toContain(
			'manifest:full-path="Pictures/image1.png" manifest:media-type="image/png"'
		);
		expect(body).toContain(
			'<text:p text:style-name="Picture_right"><draw:frame draw:name="Picture 1" text:anchor-type="as-char" svg:width="250.00pt" svg:height="125.00pt"'
		);
		expect(body).toContain('<svg:desc>Chart</svg:desc>');
	});

	it('keeps a code block’s spaces, its tabs as four, and its lines', async () => {
		const { body } = await build('```\n  a  b\n\tc\n```');
		expect(body).toContain(
			'<text:s text:c="2"/>a <text:s/>b<text:line-break/><text:s text:c="4"/>c'
		);
	});

	it('sets the page, the title once, and the contents', async () => {
		const opts: DocumentOptions = {
			pageSize: 'a4',
			style: 'report',
			title: 'Heat Pumps',
			toc: true
		};
		const { body, styles, part } = await build('# Heat pumps\n\n## Costs\n\nx', opts);
		expect(styles).toContain('fo:page-width="595.28pt" fo:page-height="841.89pt"');
		expect(body.match(/Heat [Pp]umps/g)).toEqual(['Heat Pumps']);
		expect(body).toContain('<text:index-source-style text:style-name="Heading_20_2"/>');
		expect(body).toMatch(/<text:p text:style-name="Contents_20_1">Costs<\/text:p>/);
		expect(await part('meta.xml')).toContain('<dc:title>Heat Pumps</dc:title>');
		// A report's running title, not on its first page, whose page number stays.
		expect(styles).toContain(
			'<style:header><text:p text:style-name="Header">Heat Pumps</text:p></style:header>'
		);
		expect(styles).toContain(
			'<style:footer-first><text:p text:style-name="Footer"><text:page-number'
		);
	});

	it('leaves the page number off the first page of a letter', async () => {
		const { styles } = await build('Dear Sam,', { ...PLAIN, style: 'letter' });
		expect(styles).toContain(
			'<style:footer-first><text:p text:style-name="Footer"></text:p></style:footer-first>'
		);
	});
});

describe('spaced', () => {
	it('keeps runs of spaces that ODF would collapse, and leading ones', () => {
		expect(spaced('a b')).toBe('a b');
		expect(spaced('a   b')).toBe('a <text:s text:c="2"/>b');
		expect(spaced(' a')).toBe('<text:s/>a');
		expect(spaced('a\tb\nc & d')).toBe('a<text:tab/>b<text:line-break/>c &amp; d');
	});
});
