import { describe, expect, it } from 'vitest';
import { edgeSpeed, scrollParent } from './dragAutoScroll';

describe('edgeSpeed', () => {
	it('is zero in the middle', () => {
		expect(edgeSpeed(500, 0, 1000)).toBe(0);
	});

	it('scrolls up near the top and down near the bottom', () => {
		expect(edgeSpeed(10, 0, 1000)).toBeLessThan(0);
		expect(edgeSpeed(990, 0, 1000)).toBeGreaterThan(0);
	});

	it('goes faster closer to the edge and caps past it', () => {
		expect(edgeSpeed(980, 0, 1000)).toBeGreaterThan(edgeSpeed(960, 0, 1000));
		expect(edgeSpeed(1200, 0, 1000)).toBe(edgeSpeed(1000, 0, 1000));
		expect(edgeSpeed(-50, 0, 1000)).toBe(-edgeSpeed(1000, 0, 1000));
	});

	it('keeps a small scroller mostly free of edge zones', () => {
		expect(edgeSpeed(50, 0, 100)).toBe(0);
		expect(edgeSpeed(0, 0, 0)).toBe(0);
	});
});

describe('scrollParent', () => {
	it('picks the node itself when it scrolls', () => {
		const outer = document.createElement('div');
		outer.style.overflowY = 'auto';
		const view = document.createElement('div');
		view.style.overflowY = 'auto';
		outer.append(view);
		document.body.append(outer);
		expect(scrollParent(view)).toBe(view);
		outer.remove();
	});

	it('walks up to a scrolling ancestor', () => {
		const outer = document.createElement('div');
		outer.style.overflowY = 'scroll';
		const inner = document.createElement('div');
		outer.append(inner);
		document.body.append(outer);
		expect(scrollParent(inner)).toBe(outer);
		outer.remove();
	});

	it('falls back to the page', () => {
		const el = document.createElement('div');
		document.body.append(el);
		expect(scrollParent(el)).toBe(document.scrollingElement ?? document.documentElement);
		el.remove();
	});
});
