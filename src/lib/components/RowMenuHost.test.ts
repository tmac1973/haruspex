import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import RowMenuHost from './RowMenuHost.svelte';
import { rowMenu } from '#lib/actions/rowMenu.ts';
import { closeRowMenu, getRowMenu, type RowMenuItem } from '#lib/stores/rowMenu.svelte.ts';

function makeRow(items: () => RowMenuItem[]): HTMLButtonElement {
	const row = document.createElement('button');
	row.textContent = 'A row';
	document.body.appendChild(row);
	rowMenu(row, items);
	return row;
}

beforeEach(() => {
	closeRowMenu();
	document.body.innerHTML = '';
	render(RowMenuHost);
});

describe('row menu', () => {
	it('opens on right-click at the pointer and runs the picked item', async () => {
		const rename = vi.fn();
		const row = makeRow(() => [{ label: 'Rename', run: rename }]);
		const event = new MouseEvent('contextmenu', {
			bubbles: true,
			cancelable: true,
			clientX: 40,
			clientY: 50
		});
		row.dispatchEvent(event);
		await tick();
		expect(event.defaultPrevented).toBe(true);
		expect(getRowMenu()).toMatchObject({ x: 40, y: 50 });

		await fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
		expect(rename).toHaveBeenCalledOnce();
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('leaves the browser menu alone when a row has nothing to offer', async () => {
		const row = makeRow(() => []);
		const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		row.dispatchEvent(event);
		await tick();
		expect(event.defaultPrevented).toBe(false);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('opens from the keyboard, walks with the arrows, and Escape gives focus back', async () => {
		const row = makeRow(() => [
			{ label: 'Rename', run: vi.fn() },
			{ label: 'Pin', run: vi.fn(), disabled: true },
			{ label: 'Delete…', run: vi.fn(), danger: true }
		]);
		row.focus();
		await fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
		await tick();
		await tick();
		expect(document.activeElement?.textContent?.trim()).toBe('Rename');

		// The disabled item is skipped.
		await fireEvent.keyDown(window, { key: 'ArrowDown' });
		expect(document.activeElement?.textContent?.trim()).toBe('Delete…');
		expect(screen.getByRole('menuitem', { name: 'Delete…' }).classList).toContain('danger');
		await fireEvent.keyDown(window, { key: 'ArrowDown' });
		expect(document.activeElement?.textContent?.trim()).toBe('Rename');

		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(row);
	});

	it('the Menu key opens it too', async () => {
		const row = makeRow(() => [{ label: 'Rename', run: vi.fn() }]);
		await fireEvent.keyDown(row, { key: 'ContextMenu' });
		screen.getByRole('menu');
	});

	it('closes on a press outside it', async () => {
		const row = makeRow(() => [{ label: 'Rename', run: vi.fn() }]);
		await fireEvent.contextMenu(row);
		screen.getByRole('menu');
		await fireEvent.pointerDown(document.body);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('builds its items when it opens, so they show the row as it is now', async () => {
		let pinned = false;
		const row = makeRow(() => [{ label: pinned ? 'Unpin' : 'Pin', run: vi.fn() }]);
		pinned = true;
		await fireEvent.contextMenu(row);
		screen.getByRole('menuitem', { name: 'Unpin' });
	});
});
