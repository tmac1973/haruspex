/**
 * Delegated click handling for buttons inside rendered markdown.
 *
 * The markdown renderer emits raw HTML strings, so its buttons can't carry
 * Svelte handlers — and inline `onclick` attributes are stripped by the
 * sanitizer (and blocked by CSP). Instead the renderer tags each button with
 * a `data-action` attribute and this module routes clicks for all of them
 * via one document-level listener.
 */

const codeFor = (btn: HTMLElement): string =>
	btn.closest('.code-block')?.querySelector('code')?.textContent ?? '';

export function handleMarkdownAction(event: MouseEvent): void {
	const target = event.target as HTMLElement | null;
	const btn = target?.closest<HTMLElement>('button[data-action]');
	if (!btn) return;
	switch (btn.dataset.action) {
		case 'copy':
			void navigator.clipboard.writeText(codeFor(btn));
			break;
		case 'shell-paste':
			document.dispatchEvent(new CustomEvent('hsp-shell-paste', { detail: codeFor(btn) }));
			break;
		case 'shell-run':
			document.dispatchEvent(new CustomEvent('hsp-shell-run', { detail: codeFor(btn) }));
			break;
	}
}

/** Install the listener; returns the teardown for onDestroy. */
export function installMarkdownActions(): () => void {
	document.addEventListener('click', handleMarkdownAction);
	return () => document.removeEventListener('click', handleMarkdownAction);
}
