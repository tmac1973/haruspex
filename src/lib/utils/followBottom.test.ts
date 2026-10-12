import { describe, it, expect } from 'vitest';
import { followBottom } from './followBottom.ts';

/** A scroller whose content is `content` px tall in a 100 px window. */
function scroller(content: number) {
	const node = document.createElement('div');
	Object.defineProperty(node, 'clientHeight', { value: 100 });
	Object.defineProperty(node, 'scrollHeight', { get: () => content, configurable: true });
	return {
		node,
		grow(to: number) {
			content = to;
		}
	};
}

const settle = () => new Promise<void>((r) => queueMicrotask(r));

describe('followBottom', () => {
	it('pins to the bottom as the transcript grows', async () => {
		const s = scroller(500);
		const action = followBottom(s.node, 1)!;
		await settle();
		expect(s.node.scrollTop).toBe(500);
		s.grow(800);
		action.update!(2);
		await settle();
		expect(s.node.scrollTop).toBe(800);
	});

	it('stops following once the reader scrolls up, and resumes at the bottom', async () => {
		const s = scroller(500);
		const action = followBottom(s.node, 1)!;
		await settle();
		s.node.scrollTop = 100;
		s.node.dispatchEvent(new Event('scroll'));
		s.grow(800);
		action.update!(2);
		await settle();
		expect(s.node.scrollTop).toBe(100);

		s.node.scrollTop = 680;
		s.node.dispatchEvent(new Event('scroll'));
		s.grow(900);
		action.update!(3);
		await settle();
		expect(s.node.scrollTop).toBe(900);
	});
});
