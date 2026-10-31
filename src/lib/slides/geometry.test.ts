import { describe, it, expect } from 'vitest';
import {
	bodyBoxes,
	columnBoxes,
	coverBoxes,
	coverImage,
	fitImage,
	imageBoxes,
	numberBox,
	pageSize,
	quoteBoxes,
	ruleBox,
	sectionBoxes,
	statBoxes,
	titleBox
} from './geometry';
import type { Box } from './geometry';

const inside = (inner: Box, outer: { w: number; h: number }) =>
	inner.x >= 0 &&
	inner.y >= 0 &&
	inner.x + inner.w <= outer.w + 1e-9 &&
	inner.y + inner.h <= outer.h + 1e-9;

describe('page size', () => {
	it('is 16:9 in landscape and 9:16 in portrait', () => {
		expect(pageSize('landscape')).toEqual({ w: 40 / 3, h: 7.5 });
		expect(pageSize('portrait')).toEqual({ w: 7.5, h: 40 / 3 });
	});
});

describe.each(['landscape', 'portrait'] as const)('%s', (orientation) => {
	const page = pageSize(orientation);

	it('keeps every box on the page', () => {
		const withImage = bodyBoxes(orientation, true);
		const columns = columnBoxes(orientation);
		for (const box of [
			...Object.values(sectionBoxes(orientation)),
			...Object.values(coverBoxes(orientation)),
			...Object.values(imageBoxes(orientation)),
			...Object.values(quoteBoxes(orientation)),
			...Object.values(statBoxes(orientation)),
			titleBox(orientation),
			ruleBox(orientation),
			numberBox(orientation),
			bodyBoxes(orientation, false).bullets,
			withImage.bullets,
			withImage.image!,
			columns.left,
			columns.right
		]) {
			expect(inside(box, page), JSON.stringify(box)).toBe(true);
		}
	});

	it('puts the body under the title and its rule, and above the slide number', () => {
		const rule = ruleBox(orientation);
		expect(rule.y).toBeGreaterThan(titleBox(orientation).y + titleBox(orientation).h);
		const body = bodyBoxes(orientation, false).bullets;
		expect(body.y).toBeGreaterThan(rule.y + rule.h);
		expect(body.y + body.h).toBeLessThanOrEqual(numberBox(orientation).y);
	});

	it('keeps the columns apart and the same size', () => {
		const { left, right } = columnBoxes(orientation);
		expect(right.w * right.h).toBeCloseTo(left.w * left.h);
		const apart =
			orientation === 'landscape' ? right.x > left.x + left.w : right.y > left.y + left.h;
		expect(apart).toBe(true);
	});

	it('keeps the image slide’s title on its strip', () => {
		const { strip, title, subtitle } = imageBoxes(orientation);
		expect(title.y).toBeGreaterThanOrEqual(strip.y);
		expect(subtitle.y + subtitle.h).toBeLessThanOrEqual(strip.y + strip.h);
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

describe('covering with a picture', () => {
	const box = { x: 0, y: 0, w: 8, h: 4 };

	it('scales a tall picture to the box’s width and shows its middle', () => {
		const { size, crop } = coverImage(box, 100, 100);
		expect(size).toEqual({ w: 8, h: 8 });
		expect(crop).toEqual({ x: 0, y: 2, w: 8, h: 4 });
	});

	it('scales a wide picture to the box’s height and shows its middle', () => {
		const { size, crop } = coverImage(box, 400, 100);
		expect(size).toEqual({ w: 16, h: 4 });
		expect(crop).toEqual({ x: 4, y: 0, w: 8, h: 4 });
	});
});
