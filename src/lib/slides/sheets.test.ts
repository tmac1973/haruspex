import { describe, it, expect } from 'vitest';
import {
	DOCUMENT_SHEETS,
	MAX_SHEETS,
	SHEET_GAP,
	SLIDES_PER_SHEET,
	cellOrigin,
	planSheets
} from './sheets';

describe('planSheets', () => {
	it('sizes a landscape cell 512 wide and a portrait one 512 tall', () => {
		expect(planSheets(1, 16 / 9).cell).toEqual({ w: 512, h: 288 });
		expect(planSheets(1, 9 / 16).cell).toEqual({ w: 288, h: 512 });
	});

	it('puts up to three slides in a row, and narrows a sheet with fewer', () => {
		const two = planSheets(2, 16 / 9).sheets[0];
		expect(two).toMatchObject({ cols: 2, rows: 1 });
		expect(two.width).toBe(2 * 512 + 3 * SHEET_GAP);
		const seven = planSheets(7, 16 / 9).sheets[0];
		expect(seven).toMatchObject({ count: 7, cols: 3, rows: 3 });
		expect(seven.height).toBe(3 * 288 + 4 * SHEET_GAP);
	});

	it('starts a second sheet after nine, and stops after two', () => {
		const ten = planSheets(10, 16 / 9);
		expect(ten.sheets.map((s) => [s.first, s.count])).toEqual([
			[0, 9],
			[9, 1]
		]);
		const many = planSheets(40, 16 / 9);
		expect(many.sheets).toHaveLength(MAX_SHEETS);
		expect(many.shown).toBe(SLIDES_PER_SHEET * MAX_SHEETS);
		expect(many.total).toBe(40);
	});

	it("lays a document's pages out four to a sheet, two across and larger", () => {
		const letter = planSheets(9, 612 / 792, DOCUMENT_SHEETS);
		expect(letter.cell).toEqual({ w: 541, h: 700 });
		expect(letter.sheets.map((s) => [s.first, s.count, s.cols, s.rows])).toEqual([
			[0, 4, 2, 2],
			[4, 4, 2, 2]
		]);
		expect(letter.shown).toBe(8);
		expect(letter.total).toBe(9);
	});
});

describe('cellOrigin', () => {
	it('places cells left to right, then down, inside the gaps', () => {
		const plan = planSheets(5, 16 / 9);
		const sheet = plan.sheets[0];
		expect(cellOrigin(sheet, plan.cell, 0)).toEqual({ x: SHEET_GAP, y: SHEET_GAP });
		expect(cellOrigin(sheet, plan.cell, 2)).toEqual({
			x: SHEET_GAP + 2 * (512 + SHEET_GAP),
			y: SHEET_GAP
		});
		const last = cellOrigin(sheet, plan.cell, 4);
		expect(last).toEqual({ x: SHEET_GAP + 512 + SHEET_GAP, y: SHEET_GAP + 288 + SHEET_GAP });
		expect(last.x + plan.cell.w).toBeLessThanOrEqual(sheet.width);
		expect(last.y + plan.cell.h).toBeLessThanOrEqual(sheet.height);
	});
});
