/**
 * What a reviewed draft sends: its text, its HTML when the draft is
 * Markdown, and the staged files it still uses. Kept apart from the dialog
 * so it can be tested without one.
 */
import { mailBody } from '#lib/email/body.ts';
import type { StagedFile, StagedPicture } from '#lib/email/parts.ts';
import type { EmailDraft } from '#lib/stores/emailReview.svelte.ts';
import type { PartRef } from '#lib/ipc/gen/PartRef.ts';

/** The pictures the edited text still shows. */
export function usedPictures(pictures: readonly StagedPicture[], text: string): StagedPicture[] {
	// With its closing bracket, so `cid:p1` is not found inside `cid:p10`.
	return pictures.filter((p) => text.includes(`(cid:${p.cid})`));
}

/** The attachments the user kept. */
export function keptAttachments(
	attachments: readonly StagedFile[],
	removed: ReadonlySet<string>
): StagedFile[] {
	return attachments.filter((a) => !removed.has(a.partId));
}

/** The bytes the message will carry, before any optional file is built. */
export function sentSize(draft: EmailDraft, text: string, removed: ReadonlySet<string>): number {
	return [
		...usedPictures(draft.pictures ?? [], text),
		...keptAttachments(draft.attachments ?? [], removed)
	].reduce((n, f) => n + f.size, 0);
}

/** The body fields of `email_send`'s message for `text` (the edited body, quote included). */
export function messageBody(
	draft: EmailDraft,
	text: string,
	removed: ReadonlySet<string>,
	extra: PartRef[] = []
): { body: string; html?: string; parts: PartRef[] } {
	if (draft.format !== 'markdown') return { body: text, parts: [] };
	const { text: plain, html } = mailBody(text, { cidPictures: true });
	return {
		body: plain,
		html,
		parts: [
			...usedPictures(draft.pictures ?? [], text).map((p) => ({ id: p.partId, cid: p.cid })),
			...keptAttachments(draft.attachments ?? [], removed).map((a) => ({ id: a.partId })),
			...extra
		]
	};
}

/** The HTML the dialog previews: the mail's, with each picture shown from its preview URL. */
export function previewHtml(draft: EmailDraft, text: string): string {
	let { html } = mailBody(text, { cidPictures: true });
	for (const p of draft.pictures ?? []) html = html.replaceAll(`cid:${p.cid}"`, `${p.previewUrl}"`);
	return html;
}
