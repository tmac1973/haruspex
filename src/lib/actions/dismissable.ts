/**
 * Svelte action for modal-style overlays: invokes the callback when Escape is
 * pressed (preventing its default) or when the backdrop element itself — the
 * node the action is applied to, not a descendant — receives a mousedown.
 * Apply it to the backdrop so clicks inside the dialog never dismiss:
 *
 * ```svelte
 * <div class="modal-backdrop" use:dismissable={onclose}>…</div>
 * ```
 *
 * The Escape listener lives on `window` for the lifetime of the node, so
 * conditionally render the overlay (`{#if open}`) rather than hiding it.
 */
export function dismissable(node: HTMLElement, onDismiss: () => void) {
	let dismiss = onDismiss;

	const onKeydown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			dismiss();
		}
	};
	const onMousedown = (e: MouseEvent) => {
		if (e.target === node) dismiss();
	};
	window.addEventListener('keydown', onKeydown);
	node.addEventListener('mousedown', onMousedown);

	return {
		update(next: () => void) {
			dismiss = next;
		},
		destroy() {
			window.removeEventListener('keydown', onKeydown);
			node.removeEventListener('mousedown', onMousedown);
		}
	};
}
