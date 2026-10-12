import { describe, it, expect, vi } from 'vitest';
import { startDragResize } from './dragResize.ts';

function drag(widens: 'left' | 'right', moveTo: number) {
	const onResize = vi.fn();
	const onDone = vi.fn();
	startDragResize(new MouseEvent('mousedown', { clientX: 100 }), {
		width: 300,
		widens,
		clamp: (w) => Math.max(200, Math.min(400, w)),
		onResize,
		onDone
	});
	expect(document.body.style.cursor).toBe('col-resize');
	window.dispatchEvent(new MouseEvent('mousemove', { clientX: moveTo }));
	window.dispatchEvent(new MouseEvent('mouseup'));
	return { onResize, onDone };
}

describe('startDragResize', () => {
	it('widens a left panel as the pointer moves right, and persists on release', () => {
		const { onResize, onDone } = drag('right', 150);
		expect(onResize).toHaveBeenCalledWith(350);
		expect(onDone).toHaveBeenCalledWith(350);
		expect(document.body.style.cursor).toBe('');
		expect(document.body.style.userSelect).toBe('');
	});

	it('widens a right panel as the pointer moves left, within the clamp', () => {
		expect(drag('left', 50).onDone).toHaveBeenCalledWith(350);
		expect(drag('left', -500).onDone).toHaveBeenCalledWith(400);
	});

	it('stops listening after release', () => {
		const { onResize } = drag('right', 150);
		window.dispatchEvent(new MouseEvent('mousemove', { clientX: 190 }));
		expect(onResize).toHaveBeenCalledTimes(1);
	});
});
