/**
 * Svelte action that makes a non-button element behave like a button: it sets
 * `role="button"` + `tabindex="0"` and invokes the callback on click and on
 * Enter/Space (preventing Space's default scroll). Use it on clickable list
 * rows so the keyboard-activation handler isn't re-implemented per component.
 *
 * ```svelte
 * <div class="row" use:activatable={() => onselect(id)}>…</div>
 * ```
 */
export function activatable(node: HTMLElement, onActivate: () => void) {
	let activate = onActivate;
	node.setAttribute('role', 'button');
	if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0');

	const onClick = () => activate();
	const onKeydown = (e: KeyboardEvent) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			activate();
		}
	};
	node.addEventListener('click', onClick);
	node.addEventListener('keydown', onKeydown);

	return {
		update(next: () => void) {
			activate = next;
		},
		destroy() {
			node.removeEventListener('click', onClick);
			node.removeEventListener('keydown', onKeydown);
		}
	};
}
