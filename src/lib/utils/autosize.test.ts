import { describe, expect, it } from 'vitest';
import { autosizeTextarea } from './autosize.ts';

function textarea(style: string, scrollHeight: number): HTMLTextAreaElement {
	const el = document.createElement('textarea');
	el.setAttribute('style', style);
	Object.defineProperty(el, 'scrollHeight', { get: () => scrollHeight });
	document.body.append(el);
	return el;
}

describe('autosizeTextarea', () => {
	it('sets a content-box textarea to its text height, without the padding', () => {
		const el = textarea('padding: 8px 10px; border: 1px solid', 54);
		autosizeTextarea(el);
		expect(el.style.height).toBe('38px');
	});

	it('adds the borders for a border-box textarea', () => {
		const el = textarea('box-sizing: border-box; padding: 8px; border: 1px solid', 54);
		autosizeTextarea(el);
		expect(el.style.height).toBe('56px');
	});
});

describe('autosizeTextarea parent', () => {
	it('leaves the parent as it found it', () => {
		const parent = document.createElement('div');
		parent.style.minHeight = '10px';
		const el = textarea('padding: 0', 20);
		parent.append(el);
		autosizeTextarea(el);
		expect(parent.style.minHeight).toBe('10px');
		expect(el.style.height).toBe('20px');
	});
});
