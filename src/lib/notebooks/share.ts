/**
 * Email and Print for a notebook, or for one of its cards. Both start from
 * `notebookToMarkdown`, as the exports do: Email sends that Markdown as the
 * message text, with files named in brackets; Print shows it as HTML with
 * the pictures inside.
 */
import type { NotebookCard } from '#lib/notebooks/api.ts';
import { fullNotebook, inlinedMarkdown, markdownHtml, type Full } from '#lib/notebooks/export.ts';
import { notebookToMarkdown } from '#lib/notebooks/toMarkdown.ts';
import { emailText } from '#lib/share/email.ts';
import { printHtml } from '#lib/share/print.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

/** The notebook, or only `card` in it. */
export function scoped(full: Full, card?: NotebookCard): Full {
	if (!card) return full;
	return {
		...full,
		detail: { ...full.detail, cards: full.detail.cards.filter((c) => c.id === card.id) }
	};
}

/** "Card — Notebook" for one card, the notebook's title for all of it. */
export function shareTitle(full: Full, card?: NotebookCard): string {
	const nb = full.detail.notebook.title || 'Notebook';
	return card?.title ? `${card.title} — ${nb}` : nb;
}

/** The plain text an email of the notebook (or card) carries. */
export function notebookText(full: Full): string {
	return notebookToMarkdown(full.detail, { rowsOf: full.rowsOf, placeholders: true }).markdown;
}

async function load(id: string, card?: NotebookCard): Promise<Full | null> {
	try {
		return scoped(await fullNotebook(id), card);
	} catch (e) {
		showToast(`Couldn't read the notebook: ${errMessage(e)}`, { kind: 'error' });
		return null;
	}
}

export async function emailNotebook(id: string, card?: NotebookCard): Promise<void> {
	const full = await load(id, card);
	if (full) await emailText(shareTitle(full, card), notebookText(full));
}

export async function printNotebook(id: string, card?: NotebookCard): Promise<void> {
	const full = await load(id, card);
	if (!full) return;
	try {
		await printHtml(shareTitle(full, card), markdownHtml(await inlinedMarkdown(full)));
	} catch (e) {
		showToast(`Couldn't print: ${errMessage(e)}`, { kind: 'error' });
	}
}
