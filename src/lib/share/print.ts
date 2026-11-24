/**
 * Print from Chat and Notebooks. The HTML goes to Rust (`print_open`), which
 * opens a print window on the `/print` route; that window shows it with a
 * print stylesheet and its Print button opens the system dialog.
 */
import { invoke } from '@tauri-apps/api/core';
import { sanitizeHtml } from '#lib/sanitize.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';
import type { PrintDoc } from '#lib/ipc/gen/PrintDoc.ts';

/** Buttons Chat adds to rendered Markdown that do something; dropped on paper. */
const ACTION_BUTTONS = [
	'copy',
	'shell-paste',
	'shell-run',
	'notebook-add-table',
	'code-preview'
].map((a) => `button[data-action="${a}"]`);

/**
 * Rendered Chat or notebook HTML made fit for paper: action buttons gone,
 * buttons that wrap text (a notebook link, a code path) turned back into
 * text, and folded sections opened.
 */
export function printable(html: string): string {
	const doc = new DOMParser().parseFromString(`<body>${sanitizeHtml(html)}</body>`, 'text/html');
	doc.querySelectorAll(ACTION_BUTTONS.join(',')).forEach((b) => b.remove());
	doc.querySelectorAll('.code-actions').forEach((b) => b.remove());
	doc.querySelectorAll('button').forEach((b) => {
		const span = doc.createElement('span');
		span.append(...b.childNodes);
		b.replaceWith(span);
	});
	doc.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
	return doc.body.innerHTML;
}

/** Open a print window on `html`. Reports a failure as a toast. */
export async function printHtml(title: string, html: string): Promise<void> {
	try {
		const doc: PrintDoc = { title, html: printable(html) };
		await invoke('print_open', { doc });
	} catch (e) {
		showToast(`Couldn't print: ${errMessage(e)}`, { kind: 'error' });
	}
}
