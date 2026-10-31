import { describe, it, expect } from 'vitest';
import { bodyBoxes, fitImage, pageSize, sectionBoxes, titleBox } from './geometry';
import type { Box } from './geometry';

const inside = (inner: Box, outer: { w: number; h: number }) =>
	inner.x >= 0 &&
	inner.y >= 0 &&
	inner.x + inner.w <= outer.w + 1e-9 &&
	inner.y + inner.h <= outer.h + 1e-9;

describe('page size', () => {
	it('is 16:9 in landscape and 9:16 in portrait', () => {
		expect(pageSize('landscape')).toEqual({ w: 13.333, h: 7.5 });
		expect(pageSize('portrait')).toEqual({ w: 7.5, h: 13.333 });
	});
});

describe.each(['landscape', 'portrait'] as const)('%s', (orientation) => {
	const page = pageSize(orientation);

	it('keeps every box on the page', () => {
		const section = sectionBoxes(orientation);
		const withImage = bodyBoxes(orientation, true);
		for (const box of [
			section.title,
			section.subtitle,
			titleBox(orientation),
			bodyBoxes(orientation, false).bullets,
			withImage.bullets,
			withImage.image!
		]) {
			expect(inside(box, page), JSON.stringify(box)).toBe(true);
		}
	});

	it('puts the body under the title', () => {
		const title = titleBox(orientation);
		expect(bodyBoxes(orientation, false).bullets.y).toBeGreaterThan(title.y + title.h);
	});

	it('centres the section title on the page', () => {
		const { title } = sectionBoxes(orientation);
		expect(title.x + title.w / 2).toBeCloseTo(page.w / 2);
	});
});

describe('a slide with an image', () => {
	it('puts it beside the bullets in landscape', () => {
		const { bullets, image } = bodyBoxes('landscape', true);
		expect(image!.x).toBeGreaterThan(bullets.x + bullets.w);
		expect(image!.y).toBe(bullets.y);
	});

	it('puts it above the bullets in portrait, at the body’s full width', () => {
		const { bullets, image } = bodyBoxes('portrait', true);
		expect(image!.y + image!.h).toBeLessThan(bullets.y);
		expect(image!.w).toBe(bullets.w);
		expect(image!.w).toBe(bodyBoxes('portrait', false).bullets.w);
	});
});

describe('fitting a picture', () => {
	const box = { x: 1, y: 2, w: 6, h: 4 };

	it('keeps a wide picture’s shape and centres it vertically', () => {
		const fit = fitImage(box, 1200, 400);
		expect(fit.w).toBeCloseTo(6);
		expect(fit.h).toBeCloseTo(2);
		expect(fit.x).toBeCloseTo(1);
		expect(fit.y).toBeCloseTo(3);
	});

	it('keeps a tall picture’s shape and centres it horizontally', () => {
		const fit = fitImage(box, 100, 200);
		expect(fit.h).toBeCloseTo(4);
		expect(fit.w).toBeCloseTo(2);
		expect(fit.x).toBeCloseTo(3);
		expect(fit.y).toBeCloseTo(2);
	});
});
