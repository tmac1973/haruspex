import { describe, it, expect } from 'vitest';
import vfs from 'pdfmake/build/vfs_fonts.js';
import { base64ToBytes } from '#lib/utils/base64.ts';
import { drawable, fontCoverage, missingNote, type Coverage } from './glyphs';

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
