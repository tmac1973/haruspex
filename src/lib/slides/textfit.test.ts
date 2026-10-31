import { describe, it, expect } from 'vitest';
import { SHRINK_STEPS, fitScale, textHeight, wrappedLines } from './textfit';

describe('wrappedLines', () => {
	it('keeps short text on one line', () => {
		expect(wrappedLines('Hello there', 20, 10)).toBe(1);
	});

	it('wraps at word boundaries', () => {
		// 20pt in 2in: 144pt / 10.4pt per character = 13 characters a line.
		expect(wrappedLines('aaaa bbbb cccc dddd', 20, 2)).toBe(2);
		expect(wrappedLines('aaaa bbbb cccc dddd eeee ffff', 20, 2)).toBe(3);
	});

	it('gives a word longer than a line a line of its own', () => {
		expect(wrappedLines('a ' + 'x'.repeat(40) + ' b', 20, 2)).toBe(3);
	});

	it('counts empty text as one line', () => {
		expect(wrappedLines('', 20, 2)).toBe(1);
	});
});

describe('textHeight', () => {
	it('adds the lines, the gaps between paragraphs, and the inset', () => {
		const one = textHeight([{ text: 'a', pt: 20, indent: 0 }], 5);
		expect(one).toBeCloseTo((20 * 1.2) / 72 + 0.2);
		const two = textHeight(
			[
				{ text: 'a', pt: 20, indent: 0 },
				{ text: 'b', pt: 20, indent: 0 }
			],
			5,
			1,
			10
		);
		expect(two).toBeCloseTo((2 * 24 + 10) / 72 + 0.2);
	});

	it('wraps an indented paragraph sooner', () => {
		const text = 'word '.repeat(12).trim();
		const flush = textHeight([{ text, pt: 20, indent: 0 }], 4.5);
		const indented = textHeight([{ text, pt: 20, indent: 1.5 }], 4.5);
		expect(indented).toBeGreaterThan(flush);
	});
});

describe('fitScale', () => {
	const box = { x: 0, y: 0, w: 6, h: 2 };
	const paras = (n: number) => Array.from({ length: n }, () => ({ text: 'x', pt: 20, indent: 0 }));

	it('keeps full size when the text fits', () => {
		expect(fitScale(paras(3), box)).toMatchObject({ scale: 1 });
	});

	it('takes the first step that fits', () => {
		// Six lines are 144pt plus a 14.4pt inset at full size: over the 144pt box.
		const { scale, ratio } = fitScale(paras(6), box);
		expect(scale).toBe(SHRINK_STEPS[1]);
		expect(ratio).toBeLessThanOrEqual(1);
	});

	it('reports how far over the smallest step still is', () => {
		const { scale, ratio } = fitScale(paras(20), box);
		expect(scale).toBe(SHRINK_STEPS[SHRINK_STEPS.length - 1]);
		expect(ratio).toBeGreaterThan(2);
	});
});
