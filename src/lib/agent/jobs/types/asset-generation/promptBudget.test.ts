import { describe, it, expect } from 'vitest';
import { fitStyle, STYLE_BUDGET_CHARS } from './promptBudget';

/** The style from the run that exposed this: 637 characters. */
const LONG =
	'16-bit era top-down pixel art for a roguelike, 32x32 pixel scale, crisp chunky pixels ' +
	'with hard pixel edges, strictly no anti-aliasing and no blurring; near-orthogonal ' +
	'top-down view with a slight 3/4 tilt so object tops and bases both read; desaturated ' +
	'post-apocalyptic palette of ash grey, rust orange-brown, faded olive drab, dusty beige ' +
	'and oxidised teal, with rare sickly toxic-green and warning-red accents; bold near-black ' +
	'1px outline on every silhouette; flat limited shading of two or three tones per surface ' +
	'plus a single dithered shadow puddle underneath; overhead daylight from the upper left ' +
	'with short dark occlusion shadows';

describe('fitStyle', () => {
	it('leaves a style that already fits completely alone', () => {
		const short = '16-bit pixel art, flat shading, bold dark outline';
		expect(fitStyle(short)).toEqual({ text: short, truncated: false });
	});

	it('trims a style that would push the subject out of the window', () => {
		// The measured failure: at 637 characters the model rendered the style
		// with no subject at all — abstract blobs, none of the four things the
		// prompt named.
		const fitted = fitStyle(LONG);
		expect(fitted.truncated).toBe(true);
		expect(fitted.text.length).toBeLessThanOrEqual(STYLE_BUDGET_CHARS);
	});

	it('keeps the OPENING clauses, because they decide the medium', () => {
		// Measured: whatever opens the prompt picks the medium. Keeping the
		// tail instead would lose "16-bit pixel art" and gain "occlusion
		// shadows", which is the wrong half.
		expect(fitStyle(LONG).text.startsWith('16-bit era top-down pixel art')).toBe(true);
	});

	it('never cuts mid-clause', () => {
		// Half of "desaturated post-apocalyptic palette of ash grey" is worse
		// than none of it: the model reads the fragment as an instruction.
		const text = fitStyle(LONG).text;
		const clauses = LONG.replace(/;/g, ',')
			.split(',')
			.map((c) => c.trim());
		for (const kept of text.split(', ')) {
			expect(clauses).toContain(kept);
		}
	});

	it('treats a semicolon as a clause break', () => {
		// A style written with semicolons would otherwise be one
		// unsplittable clause and get truncated to nothing useful.
		const withSemis = `${'a'.repeat(200)}; ${'b'.repeat(200)}`;
		const fitted = fitStyle(withSemis);
		expect(fitted.truncated).toBe(true);
		expect(fitted.text).toBe('a'.repeat(200));
	});

	it('keeps one over-long clause rather than emitting nothing', () => {
		// An empty style loses the medium entirely, which is the one thing
		// the opening was for.
		const single = 'x'.repeat(STYLE_BUDGET_CHARS * 2);
		const fitted = fitStyle(single);
		expect(fitted.text).toBe(single);
		expect(fitted.truncated).toBe(true);
	});

	it('handles an empty style without inventing one', () => {
		expect(fitStyle('')).toEqual({ text: '', truncated: false });
		expect(fitStyle('   ')).toEqual({ text: '', truncated: false });
	});

	it('honours a caller-supplied budget', () => {
		expect(fitStyle(LONG, 60).text.length).toBeLessThanOrEqual(60);
	});
});
