import type { StyleDictionary } from 'pdfmake/interfaces';

/**
 * The options `fs_write_document` takes for a PDF: its page size, its look
 * (`style`, like a deck's theme), a title and a table of contents.
 */

export const PAGE_SIZES = ['a4', 'letter'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const PDF_STYLES = ['plain', 'report', 'letter'] as const;
export type PdfStyle = (typeof PDF_STYLES)[number];

export interface PdfOptions {
	pageSize: PageSize;
	style: PdfStyle;
	/** Printed at the top and set as the PDF's title; the first heading otherwise. */
	title?: string;
	toc: boolean;
}

/** Page sizes in points. */
export const PAGE_POINTS: Record<PageSize, { width: number; height: number }> = {
	a4: { width: 595.28, height: 841.89 },
	letter: { width: 612, height: 792 }
};

/** Where Letter is the usual paper; everywhere else uses A4. */
const LETTER_REGIONS = new Set([
	'US',
	'CA',
	'MX',
	'PH',
	'CL',
	'CO',
	'CR',
	'DO',
	'GT',
	'NI',
	'PA',
	'PR',
	'SV',
	'VE'
]);

/** The paper a user in `locale` (a BCP 47 tag, `en-GB`) prints on. */
export function localPageSize(locale: string | undefined): PageSize {
	let region: string | undefined;
	try {
		region = locale ? new Intl.Locale(locale).maximize().region : undefined;
	} catch {
		region = undefined;
	}
	return region && LETTER_REGIONS.has(region) ? 'letter' : 'a4';
}

/** What a look sets: the page's margin, the text, and the page numbers. */
export interface Look {
	margin: number;
	fontSize: number;
	lineHeight: number;
	styles: StyleDictionary;
	/** The first page that shows a page number. */
	numbersFrom: number;
	/** The title, small, at the head of every page after the first. */
	runningTitle: boolean;
}

const MUTED = '#80868f';
const ACCENT = '#1f4e79';

const BASE: StyleDictionary = {
	h1: { fontSize: 20, margin: [0, 6, 0, 8] },
	h2: { fontSize: 15.5, margin: [0, 12, 0, 6] },
	h3: { fontSize: 13, margin: [0, 10, 0, 4] },
	h4: { fontSize: 11.5, margin: [0, 8, 0, 4] },
	p: { margin: [0, 0, 0, 8] },
	title: { fontSize: 24, bold: true, margin: [0, 0, 0, 14] },
	toc: { fontSize: 15.5, bold: true, margin: [0, 0, 0, 8] },
	footer: { alignment: 'center', fontSize: 9, color: MUTED },
	header: { alignment: 'right', fontSize: 8.5, color: MUTED }
};

export const LOOKS: Record<PdfStyle, Look> = {
	plain: {
		margin: 56,
		fontSize: 11,
		lineHeight: 1.3,
		styles: BASE,
		numbersFrom: 1,
		runningTitle: false
	},
	report: {
		margin: 56,
		fontSize: 11,
		lineHeight: 1.3,
		styles: {
			...BASE,
			h1: { fontSize: 20, color: ACCENT, margin: [0, 10, 0, 8] },
			h2: { fontSize: 15.5, color: ACCENT, margin: [0, 14, 0, 6] },
			h3: { fontSize: 13, color: ACCENT, margin: [0, 10, 0, 4] },
			title: { fontSize: 28, bold: true, color: ACCENT, margin: [0, 24, 0, 6] },
			toc: { fontSize: 15.5, bold: true, color: ACCENT, margin: [0, 0, 0, 8] }
		},
		numbersFrom: 1,
		runningTitle: true
	},
	letter: {
		margin: 72,
		fontSize: 11,
		lineHeight: 1.35,
		styles: {
			...BASE,
			h1: { fontSize: 14, margin: [0, 6, 0, 8] },
			h2: { fontSize: 12.5, margin: [0, 10, 0, 6] },
			h3: { fontSize: 11.5, margin: [0, 8, 0, 4] },
			h4: { fontSize: 11, margin: [0, 8, 0, 4] },
			p: { margin: [0, 0, 0, 10] },
			title: { fontSize: 16, bold: true, margin: [0, 0, 0, 16] }
		},
		numbersFrom: 2,
		runningTitle: false
	}
};

/**
 * The PDF options in a tool call, or an error naming what's wrong. A
 * missing page size is the user's local paper.
 */
export function pdfOptions(
	args: Record<string, unknown>,
	locale: string | undefined
): PdfOptions | { error: string } {
	const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined | null => {
		const v = args[key];
		if (v === undefined || v === null || v === '') return undefined;
		const s = String(v).trim().toLowerCase();
		return (allowed as readonly string[]).includes(s) ? (s as T) : null;
	};
	const pageSize = pick('page_size', PAGE_SIZES);
	if (pageSize === null) return { error: `page_size must be ${PAGE_SIZES.join(' or ')}.` };
	const style = pick('style', PDF_STYLES);
	if (style === null) return { error: `style must be one of ${PDF_STYLES.join(', ')}.` };
	const title = typeof args.title === 'string' ? args.title.trim() : '';
	return {
		pageSize: pageSize ?? localPageSize(locale),
		style: style ?? 'plain',
		title: title || undefined,
		toc: args.toc === true || args.toc === 'true'
	};
}
