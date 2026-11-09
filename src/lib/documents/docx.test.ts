import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { documentModel } from './model';
import { buildDocx } from './docx';
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
	const zip = await JSZip.loadAsync(await buildDocx(documentModel(markdown), images, options));
	const part = async (name: string) => (await zip.file(name)?.async('string')) ?? '';
	// Every XML part has to parse, or Word won't open the file.
	for (const name of Object.keys(zip.files).filter((n) => /\.(xml|rels)$/.test(n))) {
		const doc = new DOMParser().parseFromString(await part(name), 'application/xml');
		expect(doc.getElementsByTagName('parsererror'), name).toHaveLength(0);
	}
	return { zip, part, body: await part('word/document.xml') };
}

describe('buildDocx', () => {
	it('writes headings as Word headings and styled runs', async () => {
		const { body } = await build('# Heat\n\nA **bold** and *italic* & `code`.');
		expect(body).toContain('<w:pStyle w:val="Heading1"/>');
		expect(body).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">bold</w:t>');
		expect(body).toContain('<w:rPr><w:i/></w:rPr><w:t xml:space="preserve">italic</w:t>');
		expect(body).toContain('<w:rStyle w:val="CodeChar"/>');
		expect(body).toContain(' &amp; ');
	});

	it('links through a relationship, once per address', async () => {
		const { body, part } = await build(
			'[a](https://x.org/?a=1&b=2) and [b](https://x.org/?a=1&b=2)'
		);
		expect(body.match(/<w:hyperlink r:id="rIdLink1"/g)).toHaveLength(2);
		expect(await part('word/_rels/document.xml.rels')).toContain(
			'Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://x.org/?a=1&amp;b=2" TargetMode="External"'
		);
	});

	it('numbers each ordered list from its own start, at its own level', async () => {
		const { body, part } = await build('3. a\n4. b\n   1. inner\n\n- dot\n\n1. again');
		const numbering = await part('word/numbering.xml');
		// Instance 2 starts at 3; the inner list, 3, restarts its level; 4 is the second list.
		expect(numbering).toMatch(
			/<w:num w:numId="2">.*?<w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"\/>/
		);
		expect(numbering).toMatch(
			/<w:num w:numId="3">.*?<w:lvlOverride w:ilvl="1"><w:startOverride w:val="1"\/>/
		);
		expect(numbering).toContain('<w:num w:numId="4">');
		expect(body).toContain('<w:ilvl w:val="1"/><w:numId w:val="3"/>');
		expect(body).toContain('<w:ilvl w:val="0"/><w:numId w:val="1"/>');
	});

	it('ticks a checklist instead of numbering it', async () => {
		const { body } = await build('- [x] done\n- [ ] not');
		expect(body).toContain('☒ ');
		expect(body).toContain('☐ ');
		expect(body).not.toContain('<w:numPr>');
	});

	it('writes a table with a header row that repeats, numbers on the right', async () => {
		const { body } = await build('| Item | Cost |\n|---|---|\n| Pump | 1,200 |');
		expect(body).toContain('<w:tblHeader/>');
		expect(body).toContain('<w:jc w:val="right"/>');
		expect(body.match(/<w:gridCol /g)).toHaveLength(2);
	});

	it('embeds a picture once, sized to the page, with its type declared', async () => {
		const md = '![Chart](c.png "center 50%")\n\n![Again](c.png)';
		const { zip, body, part } = await build(md, PLAIN, new Map([['c.png', png]]));
		expect(Object.keys(zip.files)).toContain('word/media/image1.png');
		expect(Object.keys(zip.files)).not.toContain('word/media/image2.png');
		expect(await part('[Content_Types].xml')).toContain(
			'<Default Extension="png" ContentType="image/png"/>'
		);
		// Half of a Letter page's 500 pt of text is 250 pt; at 2:1 it is 125 tall.
		expect(body).toContain(`<wp:extent cx="${250 * 12700}" cy="${125 * 12700}"/>`);
		expect(body).toContain('<w:jc w:val="center"/>');
		expect(body.match(/<wp:docPr id="(\d+)"/g)).toEqual(['<wp:docPr id="1"', '<wp:docPr id="2"']);
	});

	it('refuses a picture that was not loaded', async () => {
		await expect(build('![x](missing.png)')).rejects.toThrow('missing.png was not loaded');
	});

	it('sets the page size and margin, and the title once', async () => {
		const opts: DocumentOptions = {
			pageSize: 'a4',
			style: 'plain',
			title: 'Heat Pumps',
			toc: false
		};
		const { body, part } = await build('# Heat pumps\n\nText.', opts);
		expect(body).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
		expect(body).toContain('<w:pgMar w:top="1120"');
		expect(body.match(/Heat [Pp]umps/g)).toEqual(['Heat Pumps']);
		expect(await part('docProps/core.xml')).toContain('<dc:title>Heat Pumps</dc:title>');
	});

	it('lists the sections in a contents field Word fills in when it opens', async () => {
		const opts: DocumentOptions = { ...PLAIN, toc: true };
		const { body, part } = await build('# Report\n\n## Costs\n\nx\n\n## Savings\n\ny', opts);
		expect(body).toContain('TOC \\o "2-3"');
		expect(body).toMatch(/<w:pStyle w:val="TOC1"\/>.*Costs.*<w:pStyle w:val="TOC1"\/>.*Savings/);
		expect(body).toContain('<w:br w:type="page"/>');
		expect(await part('word/settings.xml')).toContain('<w:updateFields w:val="true"/>');
	});

	it('leaves the page number off the first page of a letter, and the title off a report’s', async () => {
		const letter = await build('Dear Sam,', { ...PLAIN, style: 'letter' });
		expect(letter.body).toContain('<w:titlePg/>');
		expect(letter.body).not.toContain('w:type="first"');
		const report = await build('# Heat\n\nText', { ...PLAIN, style: 'report' });
		expect(report.body).toContain('<w:footerReference w:type="first" r:id="rIdFooter"/>');
		expect(await report.part('word/header1.xml')).toContain('Heat');
		expect(await report.part('word/styles.xml')).toContain('<w:color w:val="1f4e79"/>');
	});
});
