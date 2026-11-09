import JSZip from 'jszip';
import type { SlideImage } from '#lib/slides/types.ts';
import type { Block } from '#lib/documents/model.ts';
import { LOOKS, type DocumentOptions } from '#lib/documents/looks.ts';
import { escapeXml, prepare, type Prepared } from '#lib/documents/office.ts';
import { OdtBody, para, spaced } from '#lib/documents/odtBody.ts';
import { styles } from '#lib/documents/odtStyles.ts';

/**
 * A LibreOffice (OpenDocument) text file from the tree, matching the Word
 * one (`docx.ts`): outline headings, real lists, tables, links, code,
 * quotes and pictures, on the page size and look the PDF takes.
 */

const MIME = 'application/vnd.oasis.opendocument.text';
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS =
	'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
	'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
	'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
	'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
	'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
	'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
	'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
	'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
	'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" ' +
	'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
	'office:version="1.3"';
const FONTS =
	'<office:font-face-decls>' +
	'<style:font-face style:name="Calibri" svg:font-family="Calibri" style:font-family-generic="swiss"/>' +
	'<style:font-face style:name="Courier New" svg:font-family="&apos;Courier New&apos;" style:font-family-generic="modern" style:font-pitch="fixed"/>' +
	'</office:font-face-decls>';

export async function buildOdt(
	tree: Block[],
	images: Map<string, SlideImage>,
	options: DocumentOptions
): Promise<Uint8Array> {
	const doc = prepare(tree, options);
	const look = LOOKS[options.style];
	const body = new OdtBody(doc, images);
	const text = front(doc, options, body) + body.blocks(doc.tree);
	const media = [...body.media.values()];
	const zip = new JSZip();
	// First and uncompressed, so a file manager knows it from its first bytes.
	zip.file('mimetype', MIME, { compression: 'STORE' });
	zip.file('META-INF/manifest.xml', manifest(media.map((m) => m.file)));
	zip.file('meta.xml', meta(doc.title));
	zip.file('styles.xml', styles(doc, look, { xml: XML, ns: NS, fonts: FONTS }));
	zip.file('content.xml', content(text, body, doc));
	for (const m of media) zip.file(`Pictures/${m.file}`, m.image.bytes);
	return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: MIME });
}

/** The title, and the contents with a page break after them. */
function front(doc: Prepared, options: DocumentOptions, body: OdtBody): string {
	let out = options.title ? para('Title', spaced(options.title)) : '';
	if (!doc.toc) return out;
	const [from, to] = doc.toc;
	const levels = Array.from({ length: to - from + 1 }, (_, i) => i + 1);
	const source =
		`<text:table-of-content-source text:outline-level="${levels.length}" text:use-outline-level="false" text:use-index-source-styles="true">` +
		'<text:index-title-template text:style-name="Contents_20_Heading">Contents</text:index-title-template>' +
		levels
			.map(
				(l) =>
					`<text:table-of-content-entry-template text:outline-level="${l}" text:style-name="Contents_20_${l}">` +
					'<text:index-entry-link-start/><text:index-entry-text/><text:index-entry-tab-stop style:type="right" style:leader-char="."/>' +
					'<text:index-entry-page-number/><text:index-entry-link-end/></text:table-of-content-entry-template>'
			)
			.join('') +
		levels
			.map(
				(l) =>
					`<text:index-source-styles text:outline-level="${l}"><text:index-source-style text:style-name="Heading_20_${l + from - 1}"/></text:index-source-styles>`
			)
			.join('') +
		'</text:table-of-content-source>';
	// LibreOffice fills in the page numbers on Tools → Update; until then
	// the headings are listed.
	const entries = doc.tree.flatMap((b) =>
		b.kind === 'heading' && b.level >= from && b.level <= to
			? [
					para(
						`Contents_20_${b.level - from + 1}`,
						body.runs(b.runs.map((r) => ({ ...r, link: undefined })))
					)
				]
			: []
	);
	out +=
		'<text:table-of-content text:style-name="Sect_Contents" text:protected="true" text:name="Contents">' +
		source +
		'<text:index-body><text:index-title text:style-name="Sect_Contents" text:name="Contents_Head">' +
		para('Contents_20_Heading', 'Contents') +
		'</text:index-title>' +
		entries.join('') +
		'</text:index-body></text:table-of-content>';
	return out + para('Page_Break', '');
}

function content(text: string, body: OdtBody, doc: Prepared): string {
	const textStyles = [...body.textStyles]
		.map(
			([name, props]) =>
				`<style:style style:name="${name}" style:family="text"><style:text-properties${props}/></style:style>`
		)
		.join('');
	const textWidth = doc.page.width - doc.page.margin * 2;
	const align = (name: string, parent: string, value: string) =>
		`<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${parent}"><style:paragraph-properties fo:text-align="${value}"/></style:style>`;
	const cellAligns = ['left', 'center', 'right']
		.flatMap((a) => {
			const value = a === 'left' ? 'start' : a === 'right' ? 'end' : 'center';
			return [
				align(`Table_20_Contents_${a}`, 'Table_20_Contents', value),
				align(`Table_20_Heading_${a}`, 'Table_20_Heading', value),
				align(`Picture_${a}`, 'Text_20_body', value)
			];
		})
		.join('');
	const border = '0.5pt solid #c8ccd2';
	return (
		`${XML}<office:document-content ${NS}>${FONTS}<office:automatic-styles>` +
		textStyles +
		cellAligns +
		'<style:style style:name="Page_Break" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:break-after="page"/></style:style>' +
		'<style:style style:name="Sect_Contents" style:family="section"><style:section-properties style:editable="false"/></style:style>' +
		`<style:style style:name="Table" style:family="table"><style:table-properties style:width="${textWidth.toFixed(2)}pt" table:align="margins" fo:margin-bottom="8pt"/></style:style>` +
		`<style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:padding="3pt" fo:border="none" fo:border-bottom="${border}"/></style:style>` +
		`<style:style style:name="Cell_Head" style:family="table-cell"><style:table-cell-properties fo:padding="3pt" fo:background-color="#eef0f3" fo:border="none" fo:border-bottom="1pt solid #c8ccd2"/></style:style>` +
		`</office:automatic-styles><office:body><office:text>${text}</office:text></office:body></office:document-content>`
	);
}

function manifest(media: string[]): string {
	const entry = (path: string, type: string) =>
		`<manifest:file-entry manifest:full-path="${path}" manifest:media-type="${type}"/>`;
	return (
		`${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">` +
		`<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${MIME}"/>` +
		entry('content.xml', 'text/xml') +
		entry('styles.xml', 'text/xml') +
		entry('meta.xml', 'text/xml') +
		media.map((f) => entry(`Pictures/${f}`, `image/${f.slice(f.lastIndexOf('.') + 1)}`)).join('') +
		'</manifest:manifest>'
	);
}

function meta(title: string | undefined): string {
	return (
		`${XML}<office:document-meta ${NS}><office:meta><meta:generator>Haruspex</meta:generator>` +
		(title ? `<dc:title>${escapeXml(title)}</dc:title>` : '') +
		'</office:meta></office:document-meta>'
	);
}
