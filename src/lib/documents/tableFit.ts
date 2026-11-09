import type { ContentContext } from '#lib/documents/content.ts';

/**
 * Whether a markdown table fits the page. pdfmake wraps a cell at its spaces
 * but never inside a word, so a table is as narrow as its longest words
 * allow; measured in Roboto's own widths.
 */

export const TABLE_SIZE = 10;
/** A cell's padding, left and right. */
const CELL_PAD = 12;

/**
 * Whether a table needs a landscape page: true when its columns, each as
 * narrow as its longest word, are wider than the page but fit across it.
 * Wider still, it is refused with a budget the model can cut to, since a
 * word pdfmake can't break runs off the page.
 */
export function tableFit(texts: string[][], ctx: ContentContext): boolean {
	const word = (text: string, header: boolean) =>
		Math.max(
			0,
			...text
				.split(/\s+/)
				.map((w) => (header ? ctx.measure.bold : ctx.measure.regular)(w, TABLE_SIZE))
		);
	const need = texts[0].map(
		(_, c) => Math.max(...texts.map((row, r) => word(row[c], r === 0))) + CELL_PAD
	);
	const total = need.reduce((a, b) => a + b, 0);
	const name = texts[0].filter(Boolean).slice(0, 3).join(', ') + (texts[0].length > 3 ? ', …' : '');
	if (total <= ctx.width) return false;
	if (total <= ctx.landscapeWidth) {
		ctx.landscaped.push(name);
		return true;
	}
	const fit = Math.max(1, Math.floor((ctx.landscapeWidth / total) * need.length));
	const widest = [...need.keys()]
		.sort((a, b) => need[b] - need[a])
		.slice(0, 2)
		.map((c) => `"${texts[0][c] || `column ${c + 1}`}"`)
		.join(' and ');
	throw new Error(
		`The table with columns ${name} is too wide even for a landscape page: its ` +
			`${need.length} columns need about ${Math.round(total)} pt at their narrowest, and ` +
			`${ctx.pageName} page turned sideways has ${Math.round(ctx.landscapeWidth)} pt. ` +
			`About ${fit} columns fit. Split it into tables of ${fit} columns or fewer, ` +
			`or shorten the longest words (the widest columns are ${widest}). Nothing was written.`
	);
}
