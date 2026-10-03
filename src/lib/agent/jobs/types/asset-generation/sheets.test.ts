import { describe, it, expect } from 'vitest';
import {
	assignCells,
	expectedCentre,
	gridFor,
	padding,
	planSheets,
	sheetPrompt,
	sheetRequest,
	SHEET_EDGE
} from './sheets';
import type { AssetEntry, AssetSpec } from '$lib/assets/spec/types';
import type { SheetPiece } from '$lib/ipc/gen/SheetPiece';

function entry(id: string, over: Partial<AssetEntry> = {}): AssetEntry {
	return { id, kind: 'sprite', prompt: `a ${id}`, out: `out/${id}.png`, ...over };
}

function spec(over: Partial<AssetSpec> = {}): AssetSpec {
	return {
		version: 1,
		style: { prompt: '16-bit pixel art, bold outlines.', negativePrompt: 'photo' },
		anchor: { image: 'a.png', recipe: 'a.json' },
		normalize: {} as AssetSpec['normalize'],
		entries: [],
		...over
	};
}

/** A piece centred at (cx, cy), `side` px square. */
function piece(cx: number, cy: number, side = 200): SheetPiece {
	return {
		bytes: [1],
		x: Math.round(cx - side / 2),
		y: Math.round(cy - side / 2),
		width: side,
		height: side,
		cx,
		cy,
		area: side * side
	};
}

/** A clean 3×3 layout on a 1024 sheet. */
function grid9(): SheetPiece[] {
	const c = SHEET_EDGE / 6;
	return Array.from({ length: 9 }, (_, i) =>
		piece(c * (1 + 2 * (i % 3)), c * (1 + 2 * Math.floor(i / 3)))
	);
}

describe('planSheets', () => {
	it('keeps named sheets together, in the order the names first appear', () => {
		const plans = planSheets([
			entry('sword', { sheet: 'items' }),
			entry('ghoul', { sheet: 'characters' }),
			entry('potion', { sheet: 'items' })
		]);
		expect(plans.map((p) => [p.id, p.entries.map((e) => e.id)])).toEqual([
			['items', ['sword', 'potion']],
			['characters', ['ghoul']]
		]);
	});

	it('groups unnamed entries by kind, in spec order', () => {
		const plans = planSheets([entry('sword'), entry('heart', { kind: 'icon' }), entry('potion')]);
		expect(plans.map((p) => [p.id, p.kind, p.entries.map((e) => e.id)])).toEqual([
			['sprites', 'sprite', ['sword', 'potion']],
			['icons', 'icon', ['heart']]
		]);
	});

	it('leaves textures off every sheet', () => {
		expect(planSheets([entry('grass', { kind: 'texture' })])).toEqual([]);
	});

	it('splits a group larger than a sheet into numbered sheets', () => {
		const plans = planSheets(Array.from({ length: 11 }, (_, i) => entry(`e${i}`)));
		expect(plans.map((p) => [p.id, p.entries.length])).toEqual([
			['sprites_1', 9],
			['sprites_2', 2]
		]);
	});
});

describe('gridFor', () => {
	it('is as square as possible, rows filled first', () => {
		expect(gridFor(1)).toEqual({ cols: 1, rows: 1 });
		expect(gridFor(2)).toEqual({ cols: 2, rows: 1 });
		expect(gridFor(4)).toEqual({ cols: 2, rows: 2 });
		expect(gridFor(5)).toEqual({ cols: 3, rows: 2 });
		expect(gridFor(9)).toEqual({ cols: 3, rows: 3 });
	});
});

describe('sheetPrompt', () => {
	it('spells out every position, row by row, after the style', () => {
		const p = sheetPrompt(
			['sword', 'potion', 'coin', 'wrench'].map((id) => entry(id)),
			'16-bit pixel art.'
		);
		expect(p).toMatch(
			/^16-bit pixel art\. A sprite sheet of four separate game sprites in a two by two grid/
		);
		expect(p).toContain('Row 1, left to right: a sword; a potion.');
		expect(p).toContain('Row 2, left to right: a coin; a wrench.');
	});

	it('says one row as one row, not as a grid', () => {
		// "a two by one grid" came back as two by two, with an extra subject.
		const p = sheetPrompt([entry('sword'), entry('potion')], 'pixel art');
		expect(p).toContain('two separate game sprites side by side in a single row');
		expect(p).not.toContain('grid');
	});

	it('asks for one subject as a single centred sprite, not a sheet of one', () => {
		const p = sheetPrompt([entry('sword')], 'pixel art');
		expect(p).toContain('A single game sprite of a sword.');
		expect(p).not.toMatch(/sheet|grid/);
	});
});

describe('sheetRequest', () => {
	it('asks for transparency at the sheet edge, with the seed left to the backend', () => {
		const r = sheetRequest(
			[entry('sword'), entry('potion')],
			spec({ style: { prompt: 'x', model: 'ming.safetensors' } })
		);
		expect(r).toMatchObject({
			transparent: true,
			width: SHEET_EDGE,
			height: SHEET_EDGE,
			seed: null,
			model: 'ming.safetensors'
		});
	});
});

describe('assignCells', () => {
	it('assigns an exact layout in reading order, nothing suspect', () => {
		const pieces = grid9();
		const cells = assignCells([...pieces].reverse(), 9);
		expect(cells.every((c) => c.status === 'ok' && !c.suspect)).toBe(true);
		expect(cells.map((c) => c.piece)).toEqual(pieces);
	});

	it('assigns a centred short last row in order, not by column', () => {
		// Seven subjects: the model centres the last one. By column it would
		// land in cell 8 and leave cell 7 "missing".
		const c = SHEET_EDGE / 6;
		const pieces = [...grid9().slice(0, 6), piece(3 * c, 5 * c)];
		const cells = assignCells(pieces, 7);
		expect(cells.every((x) => x.status === 'ok' && !x.suspect)).toBe(true);
		expect(cells[6].piece).toBe(pieces[6]);
	});

	it('reports a missing subject in its own cell and keeps the rest', () => {
		const pieces = grid9().filter((_, i) => i !== 4);
		const cells = assignCells(pieces, 9);
		expect(cells[4].status).toBe('missing');
		expect(cells.filter((x) => x.status === 'ok')).toHaveLength(8);
		// Assigned, but the layout as a whole did not come out as asked.
		expect(cells[0].suspect).toBe(true);
	});

	it('fails every cell a merged piece reaches', () => {
		// Subjects 0 and 1 drawn touching: one wide piece across both cells.
		const c = SHEET_EDGE / 6;
		const merged: SheetPiece = { ...piece(2 * c, c), x: 40, width: 2 * c * 2 - 80, area: 80_000 };
		const pieces = [merged, ...grid9().slice(2)];
		const cells = assignCells(pieces, 9);
		expect(cells[0].status).toBe('merge');
		expect(cells[1].status).toBe('merge');
		expect(cells[2].status).toBe('ok');
	});

	it('takes the largest of two pieces in one cell, and marks it suspect', () => {
		const pieces = grid9();
		const extra = piece(pieces[3].cx + 40, pieces[3].cy + 40, 50);
		const cells = assignCells([...pieces, extra], 9);
		expect(cells[3].piece).toBe(pieces[3]);
		expect(cells[3].suspect).toBe(true);
	});

	it('reports every cell missing on an empty sheet', () => {
		expect(assignCells([], 4).map((c) => c.status)).toEqual([
			'missing',
			'missing',
			'missing',
			'missing'
		]);
	});
});

describe('expectedCentre', () => {
	it('centres a short last row, as the model draws one', () => {
		// Seven subjects in a 3×3: the seventh sits in the middle column.
		expect(expectedCentre(6, 7, 900)).toEqual({ x: 450, y: 750 });
		expect(expectedCentre(0, 7, 900)).toEqual({ x: 150, y: 150 });
	});

	it('places a centred last subject by position even when the layout is off', () => {
		// Subject 4 missing makes the sheet inexact; the seventh, drawn
		// centred, must still be found as the seventh rather than as "missing".
		const c = SHEET_EDGE / 6;
		const pieces = [
			...grid9()
				.slice(0, 6)
				.filter((_, i) => i !== 4),
			piece(3 * c, 5 * c)
		];
		const cells = assignCells(pieces, 7);
		expect(cells[4].status).toBe('missing');
		expect(cells[6]).toMatchObject({ status: 'ok', piece: pieces[5] });
	});
});

describe('padding', () => {
	const all = [
		entry('pistol', { sheet: 'weapons' }),
		entry('shotgun', { sheet: 'weapons' }),
		entry('rifle', { sheet: 'weapons' }),
		entry('knife', { sheet: 'weapons' }),
		entry('crowbar', { sheet: 'weapons' }),
		entry('coin', { sheet: 'items' }),
		entry('grass', { kind: 'texture' })
	];

	it('fills a lone subject up to four from its own group', () => {
		expect(padding([all[1]], all).map((e) => e.id)).toEqual(['pistol', 'rifle', 'knife']);
	});

	it('leaves a sheet of four or more alone', () => {
		expect(padding(all.slice(0, 4), all)).toEqual([]);
	});

	it('never borrows from another group, and is empty when the group has no one else', () => {
		expect(padding([all[5]], all)).toEqual([]);
	});
});
