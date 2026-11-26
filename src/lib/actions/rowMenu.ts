import { openRowMenu, type RowMenuItem } from '#lib/stores/rowMenu.svelte.ts';

/**
 * Svelte action that gives a list row the shared right-click menu. It opens
 * on right-click at the pointer, and on the Menu key or Shift+F10 under the
 * row, so a keyboard user reaches the same actions.
 *
 * ```svelte
 * <button class="item" use:rowMenu={() => [{ label: 'Rename', run: … }]}>…</button>
 * ```
 *
 * The items are built when the menu opens, so they always see the row's
 * current state (a pin that is now an unpin). Return `[]` to leave the
 * browser's own menu alone, for a row that has nothing to offer.
 */
export function rowMenu(node: HTMLElement, getItems: () => RowMenuItem[]) {
	let items = getItems;

	const onContextmenu = (e: MouseEvent) => {
		const list = items();
		if (list.length === 0) return;
		e.preventDefault();
		e.stopPropagation();
		openRowMenu(e.clientX, e.clientY, list, node);
	};
	const onKeydown = (e: KeyboardEvent) => {
		if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
		const list = items();
		if (list.length === 0) return;
		e.preventDefault();
		e.stopPropagation();
		const r = node.getBoundingClientRect();
		openRowMenu(r.left + 8, r.bottom, list, node);
	};
	node.addEventListener('contextmenu', onContextmenu);
	node.addEventListener('keydown', onKeydown);

	return {
		update(next: () => RowMenuItem[]) {
			items = next;
		},
		destroy() {
			node.removeEventListener('contextmenu', onContextmenu);
			node.removeEventListener('keydown', onKeydown);
		}
	};
}
