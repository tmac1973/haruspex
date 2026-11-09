import type { Style } from 'pdfmake/interfaces';
import type { Look } from '#lib/documents/looks.ts';
import type { Prepared } from '#lib/documents/office.ts';
import { para, spaced } from '#lib/documents/odtBody.ts';

/**
 * A LibreOffice document's `styles.xml`: its named paragraph and list
 * styles, read from the look the PDF takes (`looks.ts`), and its page with
 * header and footer.
 */

/** `<?xml …?>`, the root's namespaces and the font declarations, from `odt.ts`. */
export interface StylesFrame {
	xml: string;
	ns: string;
	fonts: string;
}

/** A pdfmake style's size and colour as text properties. */
function textLook(style: Style | undefined, bold: boolean): string {
	const color = typeof style?.color === 'string' ? ` fo:color="${style.color}"` : '';
	const weight = bold ? ' fo:font-weight="bold" style:font-weight-complex="bold"' : '';
	return `<style:text-properties fo:font-size="${style?.fontSize ?? 11}pt"${weight}${color}/>`;
}

const text = (props: string) => `<style:text-properties ${props}/>`;

/** A named paragraph style: name, parent, paragraph and text properties, and extra attributes. */
type ParagraphStyle = [
	name: string,
	parent: string,
	paragraph: string,
	text: string,
	extra?: string
];

function paragraphStyles(look: Look): ParagraphStyle[] {
	const s = look.styles;
	const title = s.title as Style | undefined;
	const titleRule = look.runningTitle
		? ` fo:border-bottom="1.5pt solid ${title?.color ?? '#1f4e79'}" fo:padding-bottom="4pt"`
		: '';
	const headings = [1, 2, 3, 4, 5, 6].map((n): ParagraphStyle => [
		`Heading ${n}`,
		'Standard',
		` fo:margin-top="${n === 1 ? 12 : 10}pt" fo:margin-bottom="4pt" fo:keep-with-next="always"`,
		textLook(s[`h${Math.min(n, 4)}`] as Style | undefined, true),
		` style:next-style-name="Text_20_body" style:default-outline-level="${n}"`
	]);
	return [
		['Text body', 'Standard', ` fo:line-height="${Math.round(look.lineHeight * 100)}%"`, ''],
		['Title', 'Standard', `${titleRule} fo:margin-bottom="16pt"`, textLook(title, true)],
		...headings,
		['List Contents', 'Text body', ' fo:margin-bottom="3pt"', ''],
		[
			'Quotations',
			'Text body',
			' fo:margin-left="12pt" fo:padding-left="8pt" fo:border-left="2pt solid #c8ccd2" fo:border-right="none" fo:border-top="none" fo:border-bottom="none"',
			text('fo:color="#555b63"')
		],
		[
			'Preformatted Text',
			'Standard',
			' fo:background-color="#f3f4f6" fo:padding="5pt"',
			text('style:font-name="Courier New" fo:font-size="9pt"')
		],
		[
			'Horizontal Line',
			'Standard',
			' fo:border-bottom="0.75pt solid #c8ccd2" fo:padding-bottom="2pt" fo:margin-bottom="12pt"',
			text('fo:font-size="6pt"')
		],
		['Table Contents', 'Standard', ' fo:margin-bottom="0pt"', text('fo:font-size="10pt"')],
		['Table Heading', 'Table Contents', '', text('fo:font-weight="bold"')],
		[
			'Contents Heading',
			'Standard',
			' fo:margin-bottom="8pt"',
			textLook(s.toc as Style | undefined, true)
		],
		['Contents 1', 'Standard', ' fo:margin-bottom="3pt"', ''],
		['Contents 2', 'Standard', ' fo:margin-left="18pt" fo:margin-bottom="3pt"', ''],
		['Header', 'Standard', ' fo:text-align="end"', text('fo:font-size="8.5pt" fo:color="#80868f"')],
		['Footer', 'Standard', ' fo:text-align="center"', text('fo:font-size="9pt" fo:color="#80868f"')]
	];
}

/** A display name as ODF writes it in a style's name: a space is `_20_`. */
const encoded = (name: string) => name.replace(/ /g, '_20_');

function paragraphStyle([name, parent, paragraph, textProps, extra = '']: ParagraphStyle): string {
	return (
		`<style:style style:name="${encoded(name)}" style:display-name="${name}" style:family="paragraph" ` +
		`style:parent-style-name="${encoded(parent)}"${extra}>` +
		(paragraph ? `<style:paragraph-properties${paragraph}/>` : '') +
		textProps +
		'</style:style>'
	);
}

/** A list level's indent: its label hangs in the margin of its text. */
function levelPosition(level: number): string {
	return (
		'<style:list-level-properties text:list-level-position-and-space-mode="label-alignment">' +
		`<style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${18 * level}pt" ` +
		`fo:text-indent="-18pt" fo:margin-left="${18 * level}pt"/></style:list-level-properties>`
	);
}

/** Bullets, numbers, and a checklist whose label is its box in the text. */
function listStyles(): string {
	const list = (name: string, make: (l: number) => string) =>
		`<text:list-style style:name="${encoded(name)}" style:display-name="${name}">` +
		Array.from({ length: 10 }, (_, i) => make(i + 1)).join('') +
		'</text:list-style>';
	const number = (l: number, fmt: string) =>
		`<text:list-level-style-number text:level="${l}"${fmt ? ' style:num-suffix="."' : ''} style:num-format="${fmt}">${levelPosition(l)}</text:list-level-style-number>`;
	return (
		list(
			'List Bullet',
			(l) =>
				`<text:list-level-style-bullet text:level="${l}" text:bullet-char="${['•', '◦', '▪'][(l - 1) % 3]}">${levelPosition(l)}</text:list-level-style-bullet>`
		) +
		list('Numbering 123', (l) => number(l, ['1', 'a', 'i'][(l - 1) % 3])) +
		list('Checklist', (l) => number(l, ''))
	);
}

/** The page: its size and margins, and room for a header and footer. */
function pageLayout(doc: Prepared): string {
	const margin = `${doc.page.margin}pt`;
	return (
		`<style:page-layout style:name="Page"><style:page-layout-properties fo:page-width="${doc.page.width}pt" fo:page-height="${doc.page.height}pt" ` +
		`fo:margin-top="${margin}" fo:margin-bottom="${margin}" fo:margin-left="${margin}" fo:margin-right="${margin}"/>` +
		'<style:header-style><style:header-footer-properties fo:min-height="0pt" fo:margin-bottom="8pt"/></style:header-style>' +
		'<style:footer-style><style:header-footer-properties fo:min-height="0pt" fo:margin-top="8pt"/></style:footer-style>' +
		'</style:page-layout>'
	);
}

export function styles(doc: Prepared, look: Look, frame: StylesFrame): string {
	return (
		`${frame.xml}<office:document-styles ${frame.ns}>${frame.fonts}<office:styles>` +
		'<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-bottom="8pt"/>' +
		`<style:text-properties style:font-name="Calibri" fo:font-size="${look.fontSize}pt"/></style:default-style>` +
		'<style:style style:name="Standard" style:family="paragraph"/>' +
		paragraphStyles(look).map(paragraphStyle).join('') +
		'<style:style style:name="Internet_20_link" style:display-name="Internet link" style:family="text"><style:text-properties fo:color="#1a56b0" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>' +
		listStyles() +
		`</office:styles><office:automatic-styles>${pageLayout(doc)}</office:automatic-styles>` +
		`<office:master-styles>${masterPage(doc, look)}</office:master-styles></office:document-styles>`
	);
}

/** Header and footer, with a first page of its own where the look says. */
function masterPage(doc: Prepared, look: Look): string {
	const numbers = para(
		'Footer',
		'<text:page-number text:select-page="current">1</text:page-number> / <text:page-count>1</text:page-count>'
	);
	const title = look.runningTitle && doc.title ? para('Header', spaced(doc.title)) : '';
	let out = '<style:master-page style:name="Standard" style:page-layout-name="Page">';
	if (title)
		out += `<style:header>${title}</style:header><style:header-first>${para('Header', '')}</style:header-first>`;
	out += `<style:footer>${numbers}</style:footer>`;
	// A first page of its own takes both: LibreOffice leaves its footer
	// blank when only the header is given.
	if (look.numbersFrom > 1) out += `<style:footer-first>${para('Footer', '')}</style:footer-first>`;
	else if (title) out += `<style:footer-first>${numbers}</style:footer-first>`;
	return out + '</style:master-page>';
}
