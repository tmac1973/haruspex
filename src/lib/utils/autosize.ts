/**
 * Fit a textarea's height to its text. Measuring means dropping it to its
 * `auto` height (one row) and reading `scrollHeight`, so its parent is held
 * at its height meanwhile: otherwise the layout around it shrinks and grows
 * back on every keystroke, and a scrolled transcript above it jumps.
 *
 * `scrollHeight` counts the padding, so a content-box textarea is given it
 * less the padding, a border-box one plus its borders. `min-height` and
 * `max-height` in its CSS still apply.
 */
export function autosizeTextarea(el: HTMLTextAreaElement): void {
	const style = getComputedStyle(el);
	const px = (v: string) => parseFloat(v) || 0;
	const adjust =
		style.boxSizing === 'border-box'
			? px(style.borderTopWidth) + px(style.borderBottomWidth)
			: -(px(style.paddingTop) + px(style.paddingBottom));
	const parent = el.parentElement;
	const held = parent?.style.minHeight ?? '';
	// Its computed height is in its own box-sizing, as min-height is.
	if (parent) parent.style.minHeight = getComputedStyle(parent).height;
	el.style.height = 'auto';
	el.style.height = `${el.scrollHeight + adjust}px`;
	if (parent) parent.style.minHeight = held;
}
