/**
 * Which characters a PDF's fonts can draw. Body text is Roboto, embedded,
 * which covers Latin, Greek and Cyrillic; code is the built-in Courier, which
 * has only WinAnsi. A character a font lacks prints as nothing, so the
 * common ones are swapped for a stand-in first (`→` as `->`) and the rest
 * are left out and named in the tool result, rather than lost unseen.
 */

/** Stand-ins for characters models write that the fonts may lack. */
const STAND_INS: Record<string, string> = {
	'←': '<-',
	'→': '->',
	'↑': '^',
	'↓': 'v',
	'↔': '<->',
	'⇐': '<=',
	'⇒': '=>',
	'⇔': '<=>',
	'✓': '[x]',
	'✔': '[x]',
	'✅': '[x]',
	'✗': '[ ]',
	'✘': '[ ]',
	'❌': '[ ]',
	'★': '*',
	'☆': '*',
	'≈': '~=',
	'≠': '!=',
	'≤': '<=',
	'≥': '>=',
	'−': '-',
	'•': '-',
	' ': ' ',
	' ': ' ',
	' ': ' ',
	' ': ' ',
	' ': ' ',
	'​': '',
	'‌': '',
	'‍': '',
	'️': '',
	'﻿': ''
};

/** Box drawing, which code blocks use for trees and diagrams: Courier has none. */
function boxStandIn(cp: number): string | undefined {
	if (cp < 0x2500 || cp > 0x257f) return undefined;
	const c = String.fromCodePoint(cp);
	if ('─━┄┅┈┉╌╍═'.includes(c)) return '-';
	if ('│┃┆┇┊┋╎╏║'.includes(c)) return '|';
	return '+';
}

/** WinAnsi's characters above Latin-1: what Courier has besides it. */
const WIN_ANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'].map((c) => c.codePointAt(0)!));

function inWinAnsi(cp: number): boolean {
	return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp);
}

/** Code-point ranges, sorted, as [first, last] pairs. */
export type Coverage = number[];

/**
 * The code points a TrueType font maps, from its cmap: a Unicode subtable in
 * format 12 (full range) or 4 (the Basic Multilingual Plane).
 */
export function fontCoverage(ttf: Uint8Array): Coverage {
	const view = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
	const { format4, format12 } = unicodeSubtables(view);
	if (format12 >= 0) return format12Ranges(view, format12);
	return format4 >= 0 ? format4Ranges(view, format4) : [];
}

/** Where the cmap's Unicode subtables start, by format; -1 for none. */
function unicodeSubtables(view: DataView): { format4: number; format12: number } {
	const found = { format4: -1, format12: -1 };
	let cmap = -1;
	for (let i = 0; i < view.getUint16(4); i++) {
		const rec = 12 + i * 16;
		if (view.getUint32(rec) === 0x636d6170) cmap = view.getUint32(rec + 8);
	}
	if (cmap < 0) return found;
	for (let i = 0; i < view.getUint16(cmap + 2); i++) {
		const rec = cmap + 4 + i * 8;
		const platform = view.getUint16(rec);
		const encoding = view.getUint16(rec + 2);
		const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
		const at = cmap + view.getUint32(rec + 4);
		if (!unicode) continue;
		if (view.getUint16(at) === 12) found.format12 = at;
		else if (view.getUint16(at) === 4) found.format4 = at;
	}
	return found;
}

function format12Ranges(view: DataView, at: number): Coverage {
	const ranges: Coverage = [];
	for (let g = 0; g < view.getUint32(at + 12); g++) {
		const group = at + 16 + g * 12;
		ranges.push(view.getUint32(group), view.getUint32(group + 4));
	}
	return ranges;
}

function format4Ranges(view: DataView, at: number): Coverage {
	const segs = view.getUint16(at + 6) / 2;
	const ends = at + 14;
	const starts = ends + segs * 2 + 2;
	const offsets = starts + segs * 4;
	const ranges: Coverage = [];
	for (let s = 0; s < segs; s++) {
		const end = view.getUint16(ends + s * 2);
		const start = view.getUint16(starts + s * 2);
		const offset = view.getUint16(offsets + s * 2);
		if (start === 0xffff) continue;
		if (offset === 0) {
			ranges.push(start, end);
			continue;
		}
		// Glyphs through the index array: a zero there is "no glyph".
		for (let cp = start; cp <= end; cp++) {
			const glyph = offsets + s * 2 + offset + (cp - start) * 2;
			if (glyph + 2 <= view.byteLength && view.getUint16(glyph) !== 0) ranges.push(cp, cp);
		}
	}
	return ranges;
}

function covers(ranges: Coverage, cp: number): boolean {
	let lo = 0;
	let hi = ranges.length / 2 - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (cp < ranges[mid * 2]) hi = mid - 1;
		else if (cp > ranges[mid * 2 + 1]) lo = mid + 1;
		else return true;
	}
	return false;
}

/** What a font can draw: a coverage, or `'winansi'` for a built-in font. */
export type Repertoire = Coverage | 'winansi';

/**
 * `text` as `repertoire` can draw it: stand-ins for what it lacks, and the
 * characters with none left out and added to `missing`.
 */
export function drawable(text: string, repertoire: Repertoire, missing: Set<string>): string {
	const has = (cp: number) =>
		cp === 0x0a || (repertoire === 'winansi' ? inWinAnsi(cp) : covers(repertoire, cp));
	let out = '';
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (has(cp)) {
			out += ch;
			continue;
		}
		const stand = STAND_INS[ch] ?? boxStandIn(cp);
		if (stand !== undefined && [...stand].every((c) => has(c.codePointAt(0)!))) {
			out += stand;
			continue;
		}
		missing.add(ch);
	}
	return out;
}

/** The tool result's note on characters left out, or '' when none were. */
export function missingNote(missing: Set<string>): string {
	if (missing.size === 0) return '';
	const shown = [...missing].slice(0, 12).join(' ');
	const more = missing.size > 12 ? ` and ${missing.size - 12} more` : '';
	return `The PDF's fonts have no glyph for ${shown}${more}, so they were left out. Its fonts cover Latin, Greek and Cyrillic.`;
}
