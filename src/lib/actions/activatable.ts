/**
 * Svelte action that makes a non-button element behave like a button: it sets
 * `role="button"` + `tabindex="0"` and invokes the callback on click and on
 * Enter/Space (preventing Space's default scroll). Use it on clickable list
 * rows so the keyboard-activation handler isn't re-implemented per component.
 *
 * ```svelte
 * <div class="row" use:activatable={() => onselect(id)}>…</div>
 * ```
 *
 * Interactive children — a row's run or delete button — must be marked
 * `data-no-activate` so pressing them doesn't also activate the row:
 *
 * ```svelte
 * <button data-no-activate onclick={…}>▶</button>
 * ```
 *
 * `event.stopPropagation()` in the child does NOT do this. Svelte 5 delegates
 * click handlers to the root element, so the child's handler runs AFTER this
 * listener has already fired on the way up — a row's run button selected the
 * row as well as running it, and a history row's delete button opened the run
 * it was deleting.
 */
export function activatable(node: HTMLElement, onActivate: () => void) {
	let activate = onActivate;
	node.setAttribute('role', 'button');
	if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0');

	const fromOptedOutChild = (e: Event): boolean => {
		const target = e.target;
		return target instanceof Element && target.closest('[data-no-activate]') !== null;
	};

	const onClick = (e: MouseEvent) => {
		if (fromOptedOutChild(e)) return;
		activate();
	};
	const onKeydown = (e: KeyboardEvent) => {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		if (fromOptedOutChild(e)) return;
		e.preventDefault();
		activate();
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
