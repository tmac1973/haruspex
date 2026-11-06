import { describe, expect, it } from 'vitest';
import type PptxGenJS from 'pptxgenjs';
import { SIZES } from '#lib/slides/sizes.ts';
import { SHRINK_STEPS, textHeight } from '#lib/slides/textfit.ts';
import type { Box } from '#lib/slides/geometry.ts';
import type { Theme } from '#lib/slides/themes.ts';
import { addBullets, addFitted, fit, fitBullets, type Build } from './pptxText';

const SMALLEST = SHRINK_STEPS[SHRINK_STEPS.length - 1];
const BOX: Box = { x: 1, y: 1, w: 8, h: 4 };

function build(): Build {
	return {
		deck: {} as PptxGenJS,
		orientation: 'landscape',
		theme: { text: '222222', bodyFont: 'Inter' } as Theme,
		sizes: SIZES.landscape,
		problems: [],
		mixedRuns: false
	};
}

/** A slide that keeps what was drawn on it. */
function slide() {
	const drawn: { text: unknown; options: Record<string, unknown> }[] = [];
	const out = {
		addText: (text: unknown, options: Record<string, unknown>) => drawn.push({ text, options })
	} as unknown as PptxGenJS.Slide;
	return { out, drawn };
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('fit', () => {
	it('keeps short text at full size', () => {
		const b = build();
		expect(fit(b, 'Slide 1', 'the title', [{ text: 'Hi', pt: 30, indent: 0 }], BOX)).toBe(
			SHRINK_STEPS[0]
		);
		expect(b.problems).toEqual([]);
	});

	it('shrinks text a step at a time until it fits', () => {
		const b = build();
		const paras = [{ text: words(120), pt: 30, indent: 0 }];
		// Too tall at full size, short enough one step down.
		const box = { ...BOX, h: textHeight(paras, BOX.w, (SHRINK_STEPS[0] + SHRINK_STEPS[1]) / 2) };
		const scale = fit(b, 'Slide 1', 'the bullets', paras, box);
		expect(scale).toBeLessThan(SHRINK_STEPS[0]);
		expect(SHRINK_STEPS).toContain(scale);
		expect(b.problems).toEqual([]);
	});

	it('notes a problem, with its line budget, when text is well over at the smallest step', () => {
		const b = build();
		const paras = [{ text: words(1000), pt: 30, indent: 0 }];
		expect(fit(b, 'Slide 2', 'the bullets', paras, BOX)).toBe(SMALLEST);
		expect(b.problems).toHaveLength(1);
		expect(b.problems[0]).toMatch(/^Slide 2: the bullets take about \d+ lines/);
	});

	it('counts the extra points it is given against the room', () => {
		const paras = [{ text: words(40), pt: 30, indent: 0 }];
		const plain = fit(build(), 'S', 'x', paras, BOX);
		const crowded = fit(build(), 'S', 'x', paras, BOX, 0, 200);
		expect(crowded).toBeLessThan(plain);
	});
});

describe('fitBullets', () => {
	it('sizes nested bullets smaller, and clamps the level to the deepest size', () => {
		const deep = [{ text: words(60), level: 9 }];
		const top = [{ text: words(60), level: 0 }];
		expect(fitBullets(build(), 'S', 'x', deep, BOX)).toBeGreaterThanOrEqual(
			fitBullets(build(), 'S', 'x', top, BOX)
		);
		expect(fitBullets(build(), 'S', 'x', deep, BOX)).toBe(
			fitBullets(build(), 'S', 'x', [{ text: words(60), level: 2 }], BOX)
		);
	});

	it('leaves room for a stacked column break', () => {
		// The shortest box the two bullets fit at full size: the break tips them over.
		const bullets = ['one', 'two'];
		let h = 0.1;
		while (fitBullets(build(), 'S', 'x', bullets, { ...BOX, h }) < SHRINK_STEPS[0]) h += 0.01;
		const box = { ...BOX, h };
		expect(fitBullets(build(), 'S', 'x', bullets, box, 1)).toBeLessThan(SHRINK_STEPS[0]);
	});

	it('notes overflowing bullets as a problem', () => {
		const b = build();
		expect(fitBullets(b, 'Slide 3', 'the bullets', [words(1000)], BOX)).toBe(SMALLEST);
		expect(b.problems).toHaveLength(1);
		expect(b.problems[0]).toMatch(/^Slide 3: the bullets take about \d+ lines/);
	});
});

describe('addFitted', () => {
	it('draws one run at the fitted size in its box', () => {
		const { out, drawn } = slide();
		addFitted(build(), out, 'S', 'the title', 'Hello', BOX, 34, { bold: true });
		expect(drawn).toEqual([{ text: 'Hello', options: { ...BOX, fontSize: 34, bold: true } }]);
	});
});

describe('addBullets', () => {
	it('draws nothing for no bullets', () => {
		const { out, drawn } = slide();
		addBullets(build(), out, [], BOX, 1);
		expect(drawn).toEqual([]);
	});

	it('draws each bullet as a paragraph, bold runs split out', () => {
		const b = build();
		const { out, drawn } = slide();
		addBullets(b, out, ['plain', { text: 'a **bold** word', level: 1 }], BOX, 1);
		const runs = drawn[0].text as { text: string; options: Record<string, unknown> }[];
		expect(runs.map((r) => [r.text, r.options.bold, r.options.fontSize])).toEqual([
			['plain', false, SIZES.landscape.bullets[0]],
			['a ', false, SIZES.landscape.bullets[1]],
			['bold', true, SIZES.landscape.bullets[1]],
			[' word', false, SIZES.landscape.bullets[1]]
		]);
		expect(runs.map((r) => r.options.breakLine)).toEqual([true, false, false, true]);
		expect(runs[1].options).toMatchObject({ bullet: true, indentLevel: 1 });
		expect(runs[2].options).not.toHaveProperty('bullet');
		expect(b.mixedRuns).toBe(true);
		expect(drawn[0].options).toMatchObject({ ...BOX, valign: 'top', color: '222222' });
	});

	it('puts a wider space before the column break', () => {
		const { out, drawn } = slide();
		addBullets(build(), out, ['a', 'b', 'c'], BOX, 1, { breakAt: 2 });
		const space = (drawn[0].text as { options: { paraSpaceBefore: number } }[]).map(
			(r) => r.options.paraSpaceBefore
		);
		expect(space[0]).toBe(0);
		expect(space[2]).toBeGreaterThan(space[1]);
	});

	it('raises a short list a little above the middle', () => {
		const { out, drawn } = slide();
		addBullets(build(), out, ['a'], BOX, 1, { middle: true });
		expect(drawn[0].options).toMatchObject({ valign: 'middle', h: BOX.h * 0.75 });
	});
});
