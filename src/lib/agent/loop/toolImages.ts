/**
 * Pictures a tool hands the model (`ctx.pendingImages`: fs_read_image, PDF
 * pages, screen captures, a slide deck's preview sheets) reach it as a `user`
 * message after the tool results, since only a user message can carry an
 * image. Scans for the user's latest request skip it (`isToolImageMessage`).
 *
 * They used to be added to the turn's latest user message. On a second turn
 * that is the user's new request, which sits BEFORE the tool call: the model
 * read the pictures as something the user had attached, said "no preview
 * images came back this time", and confirmed a deck it never looked at.
 * Appended after the results and labelled with what made them, they read as
 * those tools' output. Appending also leaves the earlier prompt unchanged,
 * where rewriting an old message made the server reprocess everything after
 * it.
 */

import type { ChatMessage } from '#lib/api.ts';
import { TOOL_IMAGES_LABEL } from '#lib/agent/toolImageMessage.ts';
import type { PendingImage } from '#lib/agent/tools/index.ts';

/** The message carrying `pending`, labelled with where each picture came from. */
export function toolImagesMessage(pending: PendingImage[]): ChatMessage {
	const names = pending.map((p, i) => `${i + 1}. ${p.path}`).join('\n');
	return {
		role: 'user',
		content: [
			{ type: 'text', text: `${TOOL_IMAGES_LABEL} In order:\n${names}` },
			...pending.map((p) => ({ type: 'image_url' as const, image_url: { url: p.dataUrl } }))
		]
	};
}

/**
 * Add `pending` to the turn, after the tool results. Pushed onto `messages`
 * directly, not through `appendMessage`: the caller saves what that reports,
 * and a thread that kept every picture would carry megabytes of data URLs
 * into every later turn.
 */
export function appendToolImages(messages: ChatMessage[], pending: PendingImage[]): void {
	if (pending.length > 0) messages.push(toolImagesMessage(pending));
}
