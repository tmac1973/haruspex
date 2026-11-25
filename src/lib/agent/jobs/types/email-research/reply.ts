/**
 * The reply email's two parts, from the model's Markdown answer, built by
 * `#lib/email/body.ts`: no pictures of any kind, so nothing loads from the
 * web when the reply is opened, and links only to https, http and mailto.
 */
import { mailBody, type MailBody } from '#lib/email/body.ts';

/** Longest answer rendered, in characters; the reply's parts stay well under Rust's cap. */
export const MAX_ANSWER_CHARS = 200_000;

export const NO_SOURCES = 'No sources were listed.';
const FOOTER = 'Sent by Haruspex research by email.';

/** Whether the answer has a Sources section: a heading, a bold line or a "Sources:" line. */
export function hasSources(markdown: string): boolean {
	return /^\s*(#{1,6}\s*|\*\*\s*)?(sources|references)\b/im.test(markdown);
}

export type ReplyParts = MailBody;

/**
 * Both parts of a reply. `failure` marks the short note sent when research
 * failed, which lists no sources and says nothing about them.
 */
export function replyParts(answer: string, failure = false): ReplyParts {
	let md = answer.trim().slice(0, MAX_ANSWER_CHARS);
	if (!failure && !hasSources(md)) md += `\n\n${NO_SOURCES}`;
	return mailBody(md, { footer: FOOTER });
}

/** The note sent instead of an answer. */
export function failureNote(reason: string): string {
	const r = reason.trim().replace(/\s+/g, ' ').slice(0, 300) || 'the research did not finish';
	return `Haruspex couldn't answer this: ${r.replace(/\.$/, '')}.`;
}
