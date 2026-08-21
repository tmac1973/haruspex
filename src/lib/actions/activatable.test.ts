import { describe, it, expect, vi } from 'vitest';
import { activatable } from './activatable';

function row(): { node: HTMLElement; child: HTMLButtonElement } {
	const node = document.createElement('div');
	const child = document.createElement('button');
	node.appendChild(child);
	document.body.appendChild(node);
	return { node, child };
}

describe('activatable', () => {
	it('activates on click and on Enter/Space', () => {
		const { node } = row();
		const onActivate = vi.fn();
		activatable(node, onActivate);

		node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		node.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
		expect(onActivate).toHaveBeenCalledTimes(3);
	});

	it('makes the element a button for assistive tech', () => {
		const { node } = row();
		activatable(node, vi.fn());
		expect(node.getAttribute('role')).toBe('button');
		expect(node.getAttribute('tabindex')).toBe('0');
	});

	it('leaves an explicit tabindex alone', () => {
		// Locked rows set tabindex="-1" to drop out of the tab order.
		const { node } = row();
		node.setAttribute('tabindex', '-1');
		activatable(node, vi.fn());
		expect(node.getAttribute('tabindex')).toBe('-1');
	});

	/**
	 * Svelte 5 delegates click handlers to the root, so a child's
	 * `stopPropagation()` runs only AFTER this listener has fired on the way
	 * up — which is why a job row's run button also selected the row, and a
	 * run-history row's delete button opened the run it was deleting.
	 */
	describe('opted-out children', () => {
		it('does not activate from a click inside [data-no-activate]', () => {
			const { node, child } = row();
			child.setAttribute('data-no-activate', '');
			const onActivate = vi.fn();
			activatable(node, onActivate);

			child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			expect(onActivate).not.toHaveBeenCalled();
		});

		it('does not activate from Enter inside one either', () => {
			const { node, child } = row();
			child.setAttribute('data-no-activate', '');
			const onActivate = vi.fn();
			activatable(node, onActivate);

			child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			expect(onActivate).not.toHaveBeenCalled();
		});

		it('still activates from an unmarked child', () => {
			const { node, child } = row();
			const onActivate = vi.fn();
			activatable(node, onActivate);

			child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			expect(onActivate).toHaveBeenCalledTimes(1);
		});

		it('finds the marker on an ancestor of the event target', () => {
			// A button with an icon span inside it: the target is the span.
			const { node, child } = row();
			child.setAttribute('data-no-activate', '');
			const icon = document.createElement('span');
			child.appendChild(icon);
			const onActivate = vi.fn();
			activatable(node, onActivate);

			icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			expect(onActivate).not.toHaveBeenCalled();
		});
	});

	it('swaps the callback on update and detaches on destroy', () => {
		const { node } = row();
		const first = vi.fn();
		const second = vi.fn();
		const handle = activatable(node, first);

		handle.update(second);
		node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);

		handle.destroy();
		node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(second).toHaveBeenCalledTimes(1);
	});
});
