/**
 * How a deck's pages are laid out as contact sheets for the preview the model
 * sees: up to nine slides a sheet in a grid of three across, each numbered,
 * and two sheets at most. One sheet costs about what one page of
 * `fs_read_pdf_pages` does, and shows nine slides.
 */

/** Slides on one sheet, and sheets in one preview. */
export const SLIDES_PER_SHEET = 9;
export const MAX_SHEETS = 2;
const COLUMNS = 3;
/** A cell's long side, in pixels. */
const CELL_LONG = 512;
/** Space around and between cells, in pixels. */
export const SHEET_GAP = 12;

export interface SheetPlan {
	/** The first page (0-based) on this sheet, and how many it holds. */
	first: number;
	count: number;
	cols: number;
	rows: number;
	/** The sheet's size in pixels. */
	width: number;
	height: number;
}

export interface Sheets {
	/** One cell's size in pixels: every slide is drawn at this size. */
	cell: { w: number; h: number };
	sheets: SheetPlan[];
	/** How many pages the sheets show, of how many there are. */
	shown: number;
	total: number;
}

/** Lay out `pages` pages whose width is `aspect` times their height. */
export function planSheets(pages: number, aspect: number): Sheets {
	const cell =
		aspect >= 1
			? { w: CELL_LONG, h: Math.round(CELL_LONG / aspect) }
			: { w: Math.round(CELL_LONG * aspect), h: CELL_LONG };
	const shown = Math.min(pages, SLIDES_PER_SHEET * MAX_SHEETS);
	const sheets: SheetPlan[] = [];
	for (let first = 0; first < shown; first += SLIDES_PER_SHEET) {
		const count = Math.min(SLIDES_PER_SHEET, shown - first);
		const cols = Math.min(COLUMNS, count);
		const rows = Math.ceil(count / cols);
		sheets.push({
			first,
			count,
			cols,
			rows,
			width: cols * cell.w + (cols + 1) * SHEET_GAP,
			height: rows * cell.h + (rows + 1) * SHEET_GAP
		});
	}
	return { cell, sheets, shown, total: pages };
}

/** Where page `i` of a sheet sits on it, in pixels. */
export function cellOrigin(plan: SheetPlan, cell: { w: number; h: number }, i: number) {
	const col = i % plan.cols;
	const row = Math.floor(i / plan.cols);
	return {
		x: SHEET_GAP + col * (cell.w + SHEET_GAP),
		y: SHEET_GAP + row * (cell.h + SHEET_GAP)
	};
}
