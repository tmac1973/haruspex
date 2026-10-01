/**
 * Sprites and icons, several to an image.
 *
 * Subjects drawn in one image share a style by construction — the thing
 * IP-Adapter was trying, and failing, to impose one image at a time. It is
 * also cheaper: a nine-sprite Ming-Image sheet costs about as much as two SDXL
 * singles. The cost is that a sheet can come back laid out wrong (a subject
 * missing, two drawn touching, one in the wrong place), so every cut is
 * checked against what was asked for, cell by cell, and never trusted.
 *
 * Measured in phase 17 (`plan/local-image-generation/measurements-phase-17.md`):
 * nine per sheet at 1024, with each subject's position spelled out, cut
 * exactly 8 of 8 times with every subject right and in place. 2048 is worse,
 * not better — the model draws sprites no larger and fills the space with
 * duplicates — so a sheet is always 1024.
 */

import type { AssetEntry, AssetKind, AssetSpec } from '$lib/assets/spec/types';
import { joinNegativePrompts } from '$lib/assets/spec/types';
import type { ImageRequest } from '$lib/image/types';
import type { SheetPiece } from '$lib/ipc/gen/SheetPiece';

/** Subjects per sheet. */
export const SHEET_SIZE = 9;

/** Every sheet is generated at this edge. */
export const SHEET_EDGE = 1024;

/** One sheet's worth of entries, in the order they are asked for. */
export interface SheetPlan {
	id: string;
	kind: AssetKind;
	entries: AssetEntry[];
}

/** Sprites and icons go on sheets; a texture fills its own frame. */
export function sheetable(kind: AssetKind): boolean {
	return kind === 'sprite' || kind === 'icon';
}

/**
 * Group sprites and icons into sheets.
 *
 * A named sheet keeps its members together, in spec order, in the order the
 * names first appear. Entries with no name are grouped by kind, so a set of
 * swords and potions is drawn together rather than one by one. A group larger
 * than `SHEET_SIZE` becomes several sheets, numbered.
 */
export function planSheets(entries: AssetEntry[], size = SHEET_SIZE): SheetPlan[] {
	const groups = new Map<string, { kind: AssetKind; entries: AssetEntry[] }>();
	for (const e of entries) {
		if (!sheetable(e.kind)) continue;
		const name = e.sheet ?? `${e.kind}s`;
		const g = groups.get(name) ?? { kind: e.kind, entries: [] };
		g.entries.push(e);
		groups.set(name, g);
	}
	const plans: SheetPlan[] = [];
	for (const [name, g] of groups) {
		const chunks = Math.ceil(g.entries.length / size);
		for (let i = 0; i < chunks; i++) {
			plans.push({
				id: chunks === 1 ? name : `${name}_${i + 1}`,
				kind: g.kind,
				entries: g.entries.slice(i * size, (i + 1) * size)
			});
		}
	}
	return plans;
}

/** Columns and rows for `n` subjects: as square as possible, rows filled first. */
export function gridFor(n: number): { cols: number; rows: number } {
	const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
	return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

const NUMBER_WORDS = [
	'zero',
	'one',
	'two',
	'three',
	'four',
	'five',
	'six',
	'seven',
	'eight',
	'nine'
];

function word(n: number): string {
	return NUMBER_WORDS[n] ?? String(n);
}

/** Subject text from an entry: its prompt without a trailing full stop. */
function subject(e: AssetEntry): string {
	return e.prompt.trim().replace(/[.\s]+$/, '');
}

/**
 * The prompt for one sheet.
 *
 * Positions are spelled out row by row. Without them the same sheets cut
 * exactly 6 of 8 times rather than 8 of 8 — one seed's difference, but it
 * costs nothing. The style leads, because it is what the whole set shares.
 * One subject is not a sheet of one: it is asked for as a single centred
 * sprite, which is how a failed cell is retried alone.
 */
export function sheetPrompt(entries: AssetEntry[], style: string): string {
	const lead = style.trim().replace(/[.\s]+$/, '');
	if (entries.length === 1) {
		return (
			`${lead}. A single game sprite of ${subject(entries[0])}. ` +
			'One subject only, centred, fully visible. No text, no labels, no frame.'
		);
	}
	const { cols, rows } = gridFor(entries.length);
	const lines: string[] = [];
	for (let r = 0; r < rows; r++) {
		const row = entries.slice(r * cols, (r + 1) * cols).map(subject);
		if (row.length > 0) lines.push(`Row ${r + 1}, left to right: ${row.join('; ')}.`);
	}
	return (
		`${lead}. A sprite sheet of ${word(entries.length)} separate game sprites in a ` +
		`${word(cols)} by ${word(rows)} grid with wide empty gaps between them, all drawn at ` +
		`the same scale and in the same style. ${lines.join(' ')} ` +
		'No text, no labels, no frames.'
	);
}

/** The request for one sheet. */
export function sheetRequest(entries: AssetEntry[], spec: AssetSpec): ImageRequest {
	return {
		prompt: sheetPrompt(entries, spec.style.prompt),
		negativePrompt: joinNegativePrompts(undefined, spec.style.negativePrompt) || undefined,
		width: SHEET_EDGE,
		height: SHEET_EDGE,
		// A sheet's subjects share one seed, so no entry's pin can apply to
		// the others; the backend resolves a real one and reports it.
		seed: null,
		model: spec.style.model,
		transparent: true
	};
}

/** What one cell of a sheet held. */
export interface CellResult {
	status: 'ok' | 'missing' | 'merge';
	piece?: SheetPiece;
	/**
	 * The cell's piece was not found where the layout put it, or shared its
	 * cell with another — assigned, but worth a second look by the judge.
	 */
	suspect: boolean;
}

/** Group pieces into rows the way a reader would: by centre, with slack. */
function rowsOf(pieces: SheetPiece[]): SheetPiece[][] {
	if (pieces.length === 0) return [];
	const heights = pieces.map((p) => p.height).sort((a, b) => a - b);
	const tolerance = heights[Math.floor(heights.length / 2)] / 2;
	const sorted = [...pieces].sort((a, b) => a.cy - b.cy);
	const rows: SheetPiece[][] = [];
	let start = Number.NEGATIVE_INFINITY;
	for (const p of sorted) {
		if (p.cy - start > tolerance) {
			rows.push([]);
			start = p.cy;
		}
		rows[rows.length - 1].push(p);
	}
	return rows.map((r) => r.sort((a, b) => a.cx - b.cx));
}

/**
 * Where subject `i` of `n` should be, by the layout `sheetPrompt` asked for:
 * rows filled left to right, and a short last row centred, which is how the
 * model draws one.
 */
export function expectedCentre(i: number, n: number, edge = SHEET_EDGE): { x: number; y: number } {
	const { cols, rows } = gridFor(n);
	const r = Math.floor(i / cols);
	const inRow = Math.min(cols, n - r * cols);
	const j = i - r * cols;
	return {
		x: (edge * (j + 0.5 + (cols - inRow) / 2)) / cols,
		y: (edge * (r + 0.5)) / rows
	};
}

/**
 * Match the pieces of a sheet to the `n` subjects it was asked for.
 *
 * When the pieces form exactly the rows that were asked for, they are assigned
 * in reading order — a model does not draw a ruled grid. Otherwise each piece
 * goes to the subject whose expected position (`expectedCentre`) is nearest,
 * and per subject:
 *
 * - one piece → its candidate, suspect because the layout as a whole did not
 *   come out as asked;
 * - none → missing;
 * - several → the largest, suspect;
 * - a piece whose body covers another subject's position → a merge, and both
 *   fail. Two subjects drawn touching are not two sprites.
 */
export function assignCells(pieces: SheetPiece[], n: number, edge = SHEET_EDGE): CellResult[] {
	const { cols, rows } = gridFor(n);

	const found = rowsOf(pieces);
	const expected = Array.from({ length: rows }, (_, r) => Math.min(cols, n - r * cols));
	if (found.length === rows && found.every((row, r) => row.length === expected[r])) {
		return found.flat().map((piece) => ({ status: 'ok' as const, piece, suspect: false }));
	}

	const centres = Array.from({ length: n }, (_, i) => expectedCentre(i, n, edge));
	const byCell = new Map<number, SheetPiece[]>();
	const merged = new Set<number>();
	for (const p of pieces) {
		let home = 0;
		let best = Number.POSITIVE_INFINITY;
		centres.forEach((c, i) => {
			const d = (c.x - p.cx) ** 2 + (c.y - p.cy) ** 2;
			if (d < best) [best, home] = [d, i];
		});
		byCell.set(home, [...(byCell.get(home) ?? []), p]);
		// The piece's body, not its box: a sprite's box corners are often
		// empty, so a margin is shaved off before asking what it covers.
		const mx = p.width * 0.15;
		const my = p.height * 0.15;
		centres.forEach((c, i) => {
			const covers =
				c.x > p.x + mx && c.x < p.x + p.width - mx && c.y > p.y + my && c.y < p.y + p.height - my;
			if (i !== home && covers) {
				merged.add(i);
				merged.add(home);
			}
		});
	}

	return Array.from({ length: n }, (_, i): CellResult => {
		if (merged.has(i)) return { status: 'merge', suspect: true };
		const here = byCell.get(i) ?? [];
		if (here.length === 0) return { status: 'missing', suspect: true };
		const largest = here.reduce((a, b) => (b.area > a.area ? b : a));
		return { status: 'ok', piece: largest, suspect: true };
	});
}
