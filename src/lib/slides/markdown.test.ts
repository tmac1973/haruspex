import { describe, it, expect } from 'vitest';
import { boldRuns, markdownImage, plainText } from './markdown';

describe('markdownImage', () => {
	it('finds the path of a bullet that is only a picture', () => {
		expect(markdownImage('![A gorilla](deck/g.jpg)')).toBe('deck/g.jpg');
		expect(markdownImage('  ![](g.png)  ')).toBe('g.png');
		expect(markdownImage('![x](<g.png>)')).toBe('g.png');
		expect(markdownImage('![x](g.png "Title")')).toBe('g.png');
	});

	it('leaves a bullet with other words in it alone', () => {
		expect(markdownImage('See ![x](g.png)')).toBeUndefined();
		expect(markdownImage('[a link](https://example.com)')).toBeUndefined();
		expect(markdownImage('Plain text')).toBeUndefined();
	});
});

describe('boldRuns', () => {
	it('splits text at paired markers', () => {
		expect(boldRuns('**Habitat loss** - clearing')).toEqual([
			{ text: 'Habitat loss', bold: true },
			{ text: ' - clearing', bold: false }
		]);
		expect(boldRuns('a **b** c **d**')).toEqual([
			{ text: 'a ', bold: false },
			{ text: 'b', bold: true },
			{ text: ' c ', bold: false },
			{ text: 'd', bold: true }
		]);
	});

	it('keeps text with no markers as one plain run', () => {
		expect(boldRuns('3 * 4 = 12')).toEqual([{ text: '3 * 4 = 12', bold: false }]);
	});

	it('drops markers that don’t pair up', () => {
		expect(boldRuns('**But the risks are real:')).toEqual([
			{ text: 'But the risks are real:', bold: false }
		]);
	});
});

describe('plainText', () => {
	it('drops the markers', () => {
		expect(plainText('**Western** - Gorilla gorilla**')).toBe('Western - Gorilla gorilla');
	});
});
