/**
 * `use:focusOnMount`: focus an element shown in response to a click (an
 * inline title box, a cell editor). Waits a frame, so the click that showed
 * it has finished moving focus before this takes it.
 */
export function focusOnMount(node: HTMLElement): void {
	requestAnimationFrame(() => {
		if (node.isConnected) {
			node.focus();
			if (node instanceof HTMLInputElement) node.select();
		}
	});
}
