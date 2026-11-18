import { describe, it, expect } from 'vitest';
import { installImageDragBlock } from './imageDrag';

function drag(el: Element): boolean {
	// jsdom has no DragEvent; a cancelable plain Event stands in.
	const e = new Event('dragstart', { bubbles: true, cancelable: true });
	el.dispatchEvent(e);
	return e.defaultPrevented;
}

describe('installImageDragBlock', () => {
	it('stops an image, or a link around one, being dragged', () => {
		document.body.innerHTML =
			'<img id="i" src="x.png"><a id="l" href="#"><img src="y.png"></a><a id="t" href="#">text</a>';
		const remove = installImageDragBlock(document);

		expect(drag(document.getElementById('i')!)).toBe(true);
		expect(drag(document.getElementById('l')!)).toBe(true);
		expect(drag(document.getElementById('t')!)).toBe(false);

		remove();
		expect(drag(document.getElementById('i')!)).toBe(false);
	});
});
