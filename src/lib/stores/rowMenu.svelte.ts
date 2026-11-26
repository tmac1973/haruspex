/**
 * The one right-click menu for list rows, in every window. A row asks for it
 * through the `rowMenu` action (`actions/rowMenu.ts`); `RowMenuHost` in the
 * root layout draws it. Chat, Code, Notebooks and Jobs each grew their own
 * way to rename or delete an item (a hover ×, a menu inside the open item, a
 * button in an editor), so this keeps them on one gesture.
 */

export interface RowMenuItem {
	label: string;
	run: () => void;
	/** Drawn in the error colour: deletes, or anything else hard to undo. */
	danger?: boolean;
	disabled?: boolean;
	/** Tooltip for the item. */
	title?: string;
}

export interface OpenRowMenu {
	x: number;
	y: number;
	items: RowMenuItem[];
	/** Where focus goes back to when the menu closes without running an item. */
	returnFocus: HTMLElement | null;
}

let open = $state.raw<OpenRowMenu | null>(null);

export function openRowMenu(
	x: number,
	y: number,
	items: RowMenuItem[],
	returnFocus: HTMLElement | null = null
): void {
	if (items.length === 0) return;
	open = { x, y, items, returnFocus };
}

export function closeRowMenu(): void {
	open = null;
}

export function getRowMenu(): OpenRowMenu | null {
	return open;
}
