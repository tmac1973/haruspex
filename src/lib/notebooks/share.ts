/**
 * Email and Print for a notebook, or for one of its cards. Both start from
 * `notebookToMarkdown`, as the exports do. Email sends that Markdown as text
 * and HTML with the pictures inline and the file cards attached, and offers
 * Attach as PDF; Print shows it as HTML with the pictures inside.
 */
import type { NotebookCard } from '#lib/notebooks/api.ts';
import {
	fullNotebook,
	inlinedMarkdown,
	markdownHtml,
	notebookFile,
	type Full
} from '#lib/notebooks/export.ts';
import { emailMarkdown } from '#lib/share/email.ts';
import { prepareNotebookMail } from '#lib/share/mailParts.ts';
import { printHtml } from '#lib/share/print.ts';
import type { OptionalFile } from '#lib/stores/emailReview.svelte.ts';
import { openGitHubFile, type GitHubFileMode } from '#lib/stores/githubIssue.svelte.ts';
import { notebookToMarkdown } from '#lib/notebooks/toMarkdown.ts';
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

/** The notebook (or card) as a PDF, built only if the box is ticked. */
export function pdfAttachment(full: Full, title: string): OptionalFile {
	return {
		label: 'Attach as PDF',
		build: () => notebookFile(full, title, 'pdf')
	};
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
	if (!full) return;
	const title = shareTitle(full, card);
	await emailMarkdown(title, () => prepareNotebookMail(full), [pdfAttachment(full, title)]);
}

/**
 * The Markdown GitHub gets: tables and checklists as GFM, files and
 * pictures named (GitHub's API can't upload them). A new issue drops the
 * notebook's `# Title` line, since the issue's title says it; a comment
 * keeps it.
 */
export function githubBody(full: Full, mode: GitHubFileMode): string {
	const { markdown } = notebookToMarkdown(full.detail, { rowsOf: full.rowsOf, placeholders: true });
	return (mode === 'issue' ? markdown.replace(/^# [^\n]*\n+/, '') : markdown).trim() + '\n';
}

/** Open File on GitHub on the notebook, or one card of it. */
export async function fileOnGitHub(
	id: string,
	card: NotebookCard | undefined,
	mode: GitHubFileMode
): Promise<void> {
	const full = await load(id, card);
	if (full) openGitHubFile({ title: shareTitle(full, card), body: githubBody(full, mode), mode });
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
