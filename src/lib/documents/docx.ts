import JSZip from 'jszip';
import type { Style } from 'pdfmake/interfaces';
import type { SlideImage } from '#lib/slides/types.ts';
import type { Block } from '#lib/documents/model.ts';
import { LOOKS, type Look, type DocumentOptions } from '#lib/documents/looks.ts';
import { escapeXml, prepare, type Prepared } from '#lib/documents/office.ts';
import { DocxBody, LIST_INDENT, paragraph, text, TWIPS } from '#lib/documents/docxBody.ts';

/**
 * A Word document from the tree: headings Word knows as headings (so its
 * navigation pane and contents see them), real lists, tables with a header
 * row that repeats, links, code, quotes and pictures, on the page size and
 * look the PDF takes (`looks.ts`). Calibri, which LibreOffice draws as its
 * metric twin Carlito, as the decks do.
 */

const NS =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
	'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
	'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
	'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const FONT = 'Calibri';
const CODE_FONT = 'Courier New';

export async function buildDocx(
	tree: Block[],
	images: Map<string, SlideImage>,
	options: DocumentOptions
): Promise<Uint8Array> {
	const doc = prepare(tree, options);
	const look = LOOKS[options.style];
	const body = new DocxBody(doc, images);
	const content = front(doc, options, body) + body.blocks(doc.tree);
	const zip = new JSZip();
	const media = [...body.parts.media.values()];
	zip.file('[Content_Types].xml', contentTypes(media.map((m) => m.file)));
	zip.file(
		'_rels/.rels',
		rels([
			['rId1', `${REL}/officeDocument`, 'word/document.xml'],
			[
				'rId2',
				'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
				'docProps/core.xml'
			]
		])
	);
	zip.file('docProps/core.xml', core(doc.title));
	zip.file('word/document.xml', document(content, doc, look));
	zip.file('word/styles.xml', styles(look));
	zip.file('word/numbering.xml', numbering(body.parts.numbered));
	zip.file('word/settings.xml', settings(options.toc));
	zip.file('word/footer1.xml', footer());
	zip.file('word/header1.xml', header(look.runningTitle ? doc.title : undefined));
	zip.file(
		'word/_rels/document.xml.rels',
		rels([
			['rIdStyles', `${REL}/styles`, 'styles.xml'],
			['rIdNumbering', `${REL}/numbering`, 'numbering.xml'],
			['rIdSettings', `${REL}/settings`, 'settings.xml'],
			['rIdFooter', `${REL}/footer`, 'footer1.xml'],
			['rIdHeader', `${REL}/header`, 'header1.xml'],
			...media.map((m): Rel => [m.id, `${REL}/image`, `media/${m.file}`]),
			...[...body.parts.links].map(([href, id]): Rel => [id, `${REL}/hyperlink`, href, true])
		])
	);
	for (const m of media) zip.file(`word/media/${m.file}`, m.image.bytes);
	return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** The title, and the contents with a page break after them. */
function front(doc: Prepared, options: DocumentOptions, body: DocxBody): string {
	let out = options.title
		? paragraph('<w:pStyle w:val="Title"/>', `<w:r>${text(options.title)}</w:r>`)
		: '';
	if (!doc.toc) return out;
	const [from, to] = doc.toc;
	// Word fills the contents in when it opens the file (settings.xml asks
	// it to); until then, and in a viewer that won't, the headings are listed.
	const entries = doc.tree.flatMap((b) =>
		b.kind === 'heading' && b.level >= from && b.level <= to
			? [{ level: b.level - from + 1, runs: b.runs.map((r) => ({ ...r, link: undefined })) }]
			: []
	);
	out += paragraph('<w:pStyle w:val="TOCHeading"/>', `<w:r>${text('Contents')}</w:r>`);
	const field =
		'<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
		`<w:r><w:instrText xml:space="preserve"> TOC \\o "${from}-${to}" \\h \\z \\u </w:instrText></w:r>` +
		'<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
	const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
	if (entries.length === 0) return out + paragraph('', field + end);
	entries.forEach((e, i) => {
		const start = i === 0 ? field : '';
		const close = i === entries.length - 1 ? end : '';
		out += paragraph(`<w:pStyle w:val="TOC${e.level}"/>`, start + body.runs(e.runs) + close);
	});
	return out + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function document(content: string, doc: Prepared, look: Look): string {
	const margin = Math.round(doc.page.margin * TWIPS);
	// The first page has its own header and footer when the look leaves
	// them off it: a letter's page number, a report's running title.
	const firstOwn = look.numbersFrom > 1 || look.runningTitle;
	const refs =
		'<w:headerReference w:type="default" r:id="rIdHeader"/>' +
		'<w:footerReference w:type="default" r:id="rIdFooter"/>' +
		(firstOwn && look.numbersFrom === 1
			? '<w:footerReference w:type="first" r:id="rIdFooter"/>'
			: '');
	return (
		`${XML}<w:document ${NS}><w:body>${content}<w:sectPr>${refs}` +
		`<w:pgSz w:w="${Math.round(doc.page.width * TWIPS)}" w:h="${Math.round(doc.page.height * TWIPS)}"/>` +
		`<w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="567" w:footer="567" w:gutter="0"/>` +
		`${firstOwn ? '<w:titlePg/>' : ''}</w:sectPr></w:body></w:document>`
	);
}

function footer(): string {
	const field = (name: string) =>
		'<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
		`<w:r><w:instrText xml:space="preserve"> ${name} </w:instrText></w:r>` +
		'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r>' +
		'<w:r><w:fldChar w:fldCharType="end"/></w:r>';
	return `${XML}<w:ftr ${NS}>${paragraph('<w:pStyle w:val="Footer"/>', `${field('PAGE')}<w:r><w:t xml:space="preserve"> / </w:t></w:r>${field('NUMPAGES')}`)}</w:ftr>`;
}

function header(title: string | undefined): string {
	const content = title ? `<w:r>${text(title)}</w:r>` : '';
	return `${XML}<w:hdr ${NS}>${paragraph('<w:pStyle w:val="Header"/>', content)}</w:hdr>`;
}

type Rel = [id: string, type: string, target: string, external?: boolean];

function rels(list: Rel[]): string {
	const rows = list.map(
		([id, type, target, external]) =>
			`<Relationship Id="${id}" Type="${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ''}/>`
	);
	return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows.join('')}</Relationships>`;
}

function contentTypes(media: string[]): string {
	const part = (name: string, type: string) =>
		`<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`;
	const exts = new Set(media.map((f) => f.slice(f.lastIndexOf('.') + 1)));
	return (
		`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
		'<Default Extension="xml" ContentType="application/xml"/>' +
		[...exts].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('') +
		part('word/document.xml', 'document.main') +
		part('word/styles.xml', 'styles') +
		part('word/numbering.xml', 'numbering') +
		part('word/settings.xml', 'settings') +
		part('word/footer1.xml', 'footer') +
		part('word/header1.xml', 'header') +
		'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
		'</Types>'
	);
}

function core(title: string | undefined): string {
	return (
		`${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
		'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
		(title ? `<dc:title>${escapeXml(title)}</dc:title>` : '') +
		'</cp:coreProperties>'
	);
}

function settings(updateFields: boolean): string {
	return `${XML}<w:settings ${NS}>${updateFields ? '<w:updateFields w:val="true"/>' : ''}</w:settings>`;
}

/** A pdfmake style's size and colour as run properties. */
function runLook(style: Style | undefined, bold: boolean): string {
	const size = Math.round((style?.fontSize ?? 11) * 2);
	const color = typeof style?.color === 'string' ? style.color.replace('#', '') : undefined;
	return `${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${size}"/>`;
}

function styles(look: Look): string {
	const s = look.styles;
	const para = (id: string, name: string, pPr: string, rPr: string, extra = '') =>
		`<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>${extra}<w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;
	const headings = [1, 2, 3, 4, 5, 6]
		.map((n) => {
			const style = s[`h${Math.min(n, 4)}`] as Style | undefined;
			const before = n === 1 ? 240 : 200;
			return para(
				`Heading${n}`,
				`heading ${n}`,
				`<w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${n - 1}"/>`,
				runLook(style, true),
				'<w:uiPriority w:val="9"/><w:qFormat/>'
			);
		})
		.join('');
	const titleStyle = s.title as Style | undefined;
	const titleRule = look.runningTitle
		? `<w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="${String(titleStyle?.color ?? '#1f4e79').replace('#', '')}"/></w:pBdr>`
		: '';
	return (
		`${XML}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr>` +
		`<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/>` +
		`<w:sz w:val="${Math.round(look.fontSize * 2)}"/><w:szCs w:val="${Math.round(look.fontSize * 2)}"/>` +
		'</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>' +
		`<w:spacing w:after="160" w:line="${Math.round(look.lineHeight * 240)}" w:lineRule="auto"/>` +
		'</w:pPr></w:pPrDefault></w:docDefaults>' +
		'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
		para(
			'Title',
			'Title',
			`${titleRule}<w:spacing w:after="320"/>`,
			runLook(titleStyle, true),
			'<w:qFormat/>'
		) +
		headings +
		para('ListParagraph', 'List Paragraph', '<w:spacing w:after="60"/><w:contextualSpacing/>', '') +
		para(
			'Quote',
			'Quote',
			'<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C8CCD2"/></w:pBdr><w:ind w:left="300"/>',
			'<w:color w:val="555B63"/>'
		) +
		para(
			'Code',
			'Code',
			'<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:spacing w:line="240" w:lineRule="auto"/>',
			`<w:rFonts w:ascii="${CODE_FONT}" w:hAnsi="${CODE_FONT}" w:cs="${CODE_FONT}"/><w:sz w:val="18"/>`
		) +
		para(
			'TOCHeading',
			'TOC Heading',
			'<w:spacing w:after="160"/>',
			runLook(s.toc as Style | undefined, true)
		) +
		para('TOC1', 'toc 1', '<w:spacing w:after="60"/>', '') +
		para('TOC2', 'toc 2', `<w:spacing w:after="60"/><w:ind w:left="${LIST_INDENT}"/>`, '') +
		para(
			'Header',
			'header',
			'<w:jc w:val="right"/>',
			'<w:color w:val="80868F"/><w:sz w:val="17"/>'
		) +
		para(
			'Footer',
			'footer',
			'<w:jc w:val="center"/>',
			'<w:color w:val="80868F"/><w:sz w:val="18"/>'
		) +
		'<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1A56B0"/><w:u w:val="single"/></w:rPr></w:style>' +
		`<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="${CODE_FONT}" w:hAnsi="${CODE_FONT}" w:cs="${CODE_FONT}"/><w:sz w:val="19"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:rPr></w:style>` +
		'</w:styles>'
	);
}

const BULLETS = ['•', '◦', '▪'];
const ORDERED = ['decimal', 'lowerLetter', 'lowerRoman'];

/** Bullets are instance 1; each ordered list is its own, from its start. */
function numbering(starts: { level: number; start: number }[]): string {
	const levels = (ordered: boolean) =>
		Array.from({ length: 9 }, (_, i) => {
			const fmt = ordered ? ORDERED[i % 3] : 'bullet';
			const label = ordered ? `%${i + 1}.` : BULLETS[i % 3];
			return (
				`<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>` +
				`<w:lvlText w:val="${label}"/><w:lvlJc w:val="left"/>` +
				`<w:pPr><w:ind w:left="${LIST_INDENT * (i + 1)}" w:hanging="${LIST_INDENT}"/></w:pPr></w:lvl>`
			);
		}).join('');
	const nums = starts
		.map(
			({ level, start }, i) =>
				`<w:num w:numId="${i + 2}"><w:abstractNumId w:val="1"/>` +
				Array.from(
					{ length: 9 },
					(_, l) =>
						`<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="${l === level ? start : 1}"/></w:lvlOverride>`
				).join('') +
				'</w:num>'
		)
		.join('');
	return (
		`${XML}<w:numbering ${NS}>` +
		`<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>` +
		`<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>` +
		'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
		nums +
		'</w:numbering>'
	);
}
