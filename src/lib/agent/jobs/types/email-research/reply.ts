/**
 * The reply email's two parts, from the model's Markdown answer.
 *
 * The HTML is rendered with a plain `marked` (not chat's, which adds buttons)
 * and sanitised to a short list of tags. No images of any kind, so nothing
 * loads from the web when the reply is opened; links only to https, http and
 * mailto. The plain text is the Markdown with each link's URL written out.
 */
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

/** Longest answer rendered, in characters; the reply's parts stay well under Rust's cap. */
export const MAX_ANSWER_CHARS = 200_000;

export const NO_SOURCES = 'No sources were listed.';
const FOOTER = 'Sent by Haruspex research by email.';

const ALLOWED_TAGS = [
	'p',
	'br',
	'h1',
	'h2',
	'h3',
	'h4',
	'ul',
	'ol',
	'li',
	'strong',
	'em',
	'code',
	'pre',
	'blockquote',
	'a',
	'table',
	'thead',
	'tbody',
	'tr',
	'th',
	'td',
	'hr'
];
const ALLOWED_URI_REGEXP = /^(?:https?|mailto):/i;

const marked = new Marked({ gfm: true, breaks: true });

/** Whether the answer has a Sources section: a heading, a bold line or a "Sources:" line. */
export function hasSources(markdown: string): boolean {
	return /^\s*(#{1,6}\s*|\*\*\s*)?(sources|references)\b/im.test(markdown);
}

/** Markdown links as "text (url)", and nothing else changed. */
export function plainText(markdown: string): string {
	return markdown.replace(/\[([^\]\n]+)\]\((\S+?)\)/g, (_m, label: string, url: string) =>
		label === url ? url : `${label} (${url})`
	);
}

export function sanitizeReplyHtml(html: string): string {
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS,
		ALLOWED_ATTR: ['href'],
		ALLOWED_URI_REGEXP
	});
}

export interface ReplyParts {
	text: string;
	html: string;
}

/**
 * Both parts of a reply. `failure` marks the short note sent when research
 * failed, which lists no sources and says nothing about them.
 */
export function replyParts(answer: string, failure = false): ReplyParts {
	let md = answer.trim().slice(0, MAX_ANSWER_CHARS);
	if (!failure && !hasSources(md)) md += `\n\n${NO_SOURCES}`;
	const body = sanitizeReplyHtml(marked.parse(md) as string);
	const html = [
		'<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:720px">',
		body,
		`<hr><p style="color:#777;font-size:12px">${FOOTER}</p>`,
		'</body></html>'
	].join('');
	return { text: `${plainText(md)}\n\n—\n${FOOTER}`, html };
}

/** The note sent instead of an answer. */
export function failureNote(reason: string): string {
	const r = reason.trim().replace(/\s+/g, ' ').slice(0, 300) || 'the research did not finish';
	return `Haruspex couldn't answer this: ${r.replace(/\.$/, '')}.`;
}
