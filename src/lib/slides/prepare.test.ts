import { describe, expect, it } from 'vitest';
import { SLIDE_THEMES } from '#lib/slides/themes.ts';
import { SLIDE_LAYOUTS } from '#lib/slides/types.ts';
import {
	bulletText,
	hasRealBullets,
	normalizeOrientation,
	normalizeSlide,
	normalizeTheme,
	settleLayout
} from './prepare';

type Slide = Record<string, unknown>;

/** The slide after both passes, as fs_write_slides runs them. */
function prepared(slide: Slide): Slide {
	const s = structuredClone(slide);
	normalizeSlide(s);
	settleLayout(s);
	return s;
}

describe('bulletText and hasRealBullets', () => {
	it('reads strings and { text } objects, and nothing else', () => {
		expect(bulletText('a')).toBe('a');
		expect(bulletText({ text: 'b', level: 1 })).toBe('b');
		expect(bulletText({ text: 3 })).toBeUndefined();
		expect(bulletText(null)).toBeUndefined();
		expect(bulletText(['a'])).toBeUndefined();
	});

	it('needs at least one bullet with words in it', () => {
		expect(hasRealBullets(['', '  ', { text: ' ' }])).toBe(false);
		expect(hasRealBullets('one')).toBe(false);
		expect(hasRealBullets(['', { text: 'x' }])).toBe(true);
	});
});

describe('normalizeSlide', () => {
	it('lowercases layouts, takes the aliases and drops unknown ones', () => {
		for (const layout of SLIDE_LAYOUTS) {
			const s: Slide = { layout: ` ${layout.toUpperCase()} ` };
			normalizeSlide(s);
			expect(s.layout).toBe(layout);
		}
		const aliases: Record<string, string> = {
			title: 'cover',
			two_column: 'two-column',
			TwoColumn: 'two-column',
			columns: 'two-column'
		};
		for (const [raw, layout] of Object.entries(aliases)) {
			const s: Slide = { layout: raw };
			normalizeSlide(s);
			expect(s.layout).toBe(layout);
		}
		for (const raw of ['timeline', 1, null]) {
			const s: Slide = { layout: raw };
			normalizeSlide(s);
			expect(s).not.toHaveProperty('layout');
		}
	});

	it('drops a blank or non-string image and blank notes', () => {
		for (const image of ['', '   ', 4, { path: 'a.png' }]) {
			const s: Slide = { image, notes: '  ' };
			normalizeSlide(s);
			expect(s).toEqual({});
		}
		const s: Slide = { image: 'a.png', notes: 'Say hi' };
		normalizeSlide(s);
		expect(s).toEqual({ image: 'a.png', notes: 'Say hi' });
	});

	it('splits a string of bullets into one per line', () => {
		const s: Slide = { bullets: 'one\n\n  two  \n', right: 'three' };
		normalizeSlide(s);
		expect(s.bullets).toEqual(['one', 'two']);
		expect(s.right).toEqual(['three']);
	});

	it('drops a right column that is neither a list nor a string', () => {
		const s: Slide = { right: { text: 'x' } };
		normalizeSlide(s);
		expect(s).not.toHaveProperty('right');
	});

	it("lifts a picture bullet into the slide's image", () => {
		const s: Slide = { bullets: ['Intro', '![cat](cat.png)', '![dog](dog.png)'] };
		normalizeSlide(s);
		expect(s.image).toBe('cat.png');
		expect(s.bullets).toEqual(['Intro']);
	});

	it('keeps an image the slide already has', () => {
		const s: Slide = { image: 'own.png', bullets: ['![cat](cat.png)', 'Intro'] };
		normalizeSlide(s);
		expect(s.image).toBe('own.png');
		expect(s.bullets).toEqual(['Intro']);
	});

	it('turns columns with a picture into one list beside it', () => {
		const s: Slide = {
			layout: 'two-column',
			bullets: ['Left'],
			right: ['![chart](c.png)', 'Right']
		};
		normalizeSlide(s);
		expect(s).toEqual({ layout: 'content', image: 'c.png', bullets: ['Left', 'Right'] });
	});

	it('strips bold markers from titles, subtitles and table cells', () => {
		const s: Slide = {
			title: '**Big** news',
			subtitle: 'very **big**',
			table: [['**A**', 1], 'row']
		};
		normalizeSlide(s);
		expect(s).toEqual({ title: 'Big news', subtitle: 'very big', table: [['A', 1], 'row'] });
	});

	it('shifts a list nested all the way in back to the top level', () => {
		const s: Slide = {
			bullets: [
				{ text: 'a', level: 1 },
				{ text: 'b', level: 2 }
			],
			right: [{ text: 'c', level: 2 }]
		};
		normalizeSlide(s);
		expect(s.bullets).toEqual([
			{ text: 'a', level: 0 },
			{ text: 'b', level: 1 }
		]);
		expect(s.right).toEqual([{ text: 'c', level: 0 }]);
	});

	it('keeps real hierarchy as it is', () => {
		const bullets = ['top', { text: 'under', level: 1 }];
		const s: Slide = { bullets: structuredClone(bullets) };
		normalizeSlide(s);
		expect(s.bullets).toEqual(bullets);
	});
});

describe('settleLayout', () => {
	it('draws a chart or table on a content slide', () => {
		expect(prepared({ layout: 'quote', chart: {} }).layout).toBe('content');
		expect(prepared({ layout: 'cover', table: [['a']] }).layout).toBe('content');
	});

	it('drops an image layout with no image', () => {
		expect(prepared({ layout: 'image', bullets: ['x'] })).not.toHaveProperty('layout');
	});

	it('makes a cover with a picture an image slide', () => {
		expect(prepared({ layout: 'cover', image: 'a.png' }).layout).toBe('image');
	});

	it('makes two full columns two-column, and keeps one column as content', () => {
		expect(prepared({ bullets: ['a'], right: ['b'] })).toEqual({
			layout: 'two-column',
			bullets: ['a'],
			right: ['b']
		});
		expect(prepared({ layout: 'two-column', right: ['b'] })).toEqual({ bullets: ['b'] });
		expect(prepared({ layout: 'two-column', bullets: ['a'], right: [''] })).toEqual({
			bullets: ['a']
		});
	});

	it('drops the right column from any slide that is not two-column', () => {
		expect(prepared({ layout: 'quote', bullets: ['a'], right: ['b'] })).toEqual({
			layout: 'quote',
			bullets: ['a']
		});
	});

	it('makes an empty content slide a section divider', () => {
		expect(prepared({ title: 'Part two' })).toEqual({ title: 'Part two', layout: 'section' });
		expect(prepared({ layout: 'content', title: 'X', bullets: [' '] }).layout).toBe('section');
	});

	it("moves a content slide's subtitle into its first bullet", () => {
		expect(prepared({ subtitle: ' Why now ', bullets: ['a'] })).toEqual({
			bullets: ['Why now', 'a']
		});
		expect(prepared({ layout: 'cover', subtitle: 'Kept' })).toEqual({
			layout: 'cover',
			subtitle: 'Kept'
		});
	});
});

describe('normalizeOrientation', () => {
	it('reads portrait by either name, landscape otherwise', () => {
		expect(normalizeOrientation(' Portrait ')).toBe('portrait');
		expect(normalizeOrientation('VERTICAL')).toBe('portrait');
		expect(normalizeOrientation('landscape')).toBe('landscape');
		expect(normalizeOrientation('square')).toBe('landscape');
		expect(normalizeOrientation(undefined)).toBe('landscape');
	});
});

describe('normalizeTheme', () => {
	it('takes every theme by name, any case, and light otherwise', () => {
		for (const theme of SLIDE_THEMES) expect(normalizeTheme(` ${theme.toUpperCase()}`)).toBe(theme);
		expect(normalizeTheme('neon')).toBe('light');
		expect(normalizeTheme(3)).toBe('light');
	});
});
