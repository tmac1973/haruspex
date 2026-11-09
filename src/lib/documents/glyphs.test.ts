import { describe, it, expect } from 'vitest';
import vfs from 'pdfmake/build/vfs_fonts.js';
import { base64ToBytes } from '#lib/utils/base64.ts';
import { drawable, fontCoverage, fontMeasure, missingNote, type Coverage } from './glyphs';

const roboto: Coverage = fontCoverage(base64ToBytes(vfs['Roboto-Regular.ttf'] as string));

function draw(text: string, repertoire: Coverage | 'winansi' = roboto) {
	const missing = new Set<string>();
	return { text: drawable(text, repertoire, missing), missing: [...missing] };
}

describe('fontCoverage', () => {
	it('reads the code points Roboto maps', () => {
		expect(roboto.length).toBeGreaterThan(0);
		expect(draw('Héllo Ελληνικά Кириллица π µ €').missing).toEqual([]);
	});

	it('is empty for bytes that are not a font', () => {
		expect(fontCoverage(new Uint8Array(64))).toEqual([]);
	});
});

describe('drawable', () => {
	it('keeps what the body font has', () => {
		expect(draw('Zürich — “quoted” café').text).toBe('Zürich — “quoted” café');
	});

	it('swaps an arrow or a tick the font lacks for a stand-in', () => {
		expect(draw('12 % → 8 %, ✓ done').text).toBe('12 % -> 8 %, [x] done');
	});

	it('leaves out and names what has no stand-in', () => {
		expect(draw('Launch 🚀 漢字')).toEqual({ text: 'Launch  ', missing: ['🚀', '漢', '字'] });
	});

	it('draws a code tree in Courier with ASCII boxes', () => {
		expect(draw('├── src\n│   └── a.ts', 'winansi').text).toBe('+-- src\n|   +-- a.ts');
	});

	it('keeps WinAnsi in Courier and drops the rest', () => {
		expect(draw('café “x” — 5 €', 'winansi').text).toBe('café “x” — 5 €');
		expect(draw('π', 'winansi').missing).toEqual(['π']);
	});
});

describe('missingNote', () => {
	it('says nothing when nothing was left out', () => {
		expect(missingNote(new Set())).toBe('');
	});

	it('names a dozen at most', () => {
		const many = new Set([...'漢字仮名交じり文とは何ですかね']);
		const note = missingNote(many);
		expect(note).toContain('漢 字 仮 名');
		expect(note).toContain(`and ${many.size - 12} more`);
	});
});

describe('fontMeasure', () => {
	const measure = fontMeasure(base64ToBytes(vfs['Roboto-Regular.ttf'] as string));

	it("reads Roboto's own widths", () => {
		// A digit is 1151 of Roboto's 2048 units to the em.
		expect(measure('0', 10)).toBeCloseTo(5.62, 2);
		expect(measure('0000', 10)).toBeCloseTo(22.46, 1);
		expect(measure('MMMM', 10)).toBeGreaterThan(measure('iiii', 10) * 2);
	});

	it('measures Greek and Cyrillic, and gives what it lacks an average width', () => {
		expect(measure('Ω', 10)).toBeGreaterThan(5);
		expect(measure('Ж', 10)).toBeGreaterThan(5);
		const avg = measure('漢', 10);
		expect(avg).toBeGreaterThan(4);
		expect(avg).toBeLessThan(7);
	});
});
