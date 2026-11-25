/**
 * An email's two parts, plain text and HTML, from Markdown. Research by
 * email builds its replies here, and so do Email in Chat and Notebooks.
 *
 * The HTML is rendered with a plain `marked` (not Chat's, which adds
 * buttons) and sanitised to a short list of tags; links go only to https,
 * http and mailto. Pictures are left out, so nothing loads from the web
 * when the mail is opened, unless `cidPictures` is set: then a picture
 * whose source is `cid:` (one sent inside the message) is kept, and any
 * other is still dropped. The plain text is the Markdown with each link's
 * URL written out.
 */
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

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

const marked = new Marked({ gfm: true, breaks: true });

export interface MailBody {
	text: string;
	html: string;
}

export interface MailBodyOptions {
	/** A line under a rule at the end of both parts. */
	footer?: string;
	/** Keep pictures whose source is `cid:`. */
	cidPictures?: boolean;
}

/**
 * Markdown links as "text (url)"; with `cidPictures`, a picture as
 * "[Picture: alt]", since the plain part can't show it.
 */
export function plainText(markdown: string, cidPictures = false): string {
	const md = cidPictures
		? markdown.replace(/!\[([^\]\n]*)\]\([^)\s]+\)/g, (_m, alt: string) =>
				alt.trim() ? `[Picture: ${alt.trim()}]` : '[Picture]'
			)
		: markdown;
	return md.replace(/\[([^\]\n]+)\]\((\S+?)\)/g, (_m, label: string, url: string) =>
		label === url ? url : `${label} (${url})`
	);
}

/** Inline styles: mail clients drop `<style>`, but keep these. */
const STYLES: Record<string, string> = {
	table: 'border-collapse:collapse;margin:12px 0',
	th: 'border:1px solid #ccc;padding:4px 8px;text-align:left;background:#f4f4f4',
	td: 'border:1px solid #ccc;padding:4px 8px;text-align:left',
	pre: 'background:#f6f6f6;padding:8px;white-space:pre-wrap',
	img: 'max-width:100%;height:auto'
};

export function sanitizeMailHtml(html: string, cidPictures = false): string {
	const clean = DOMPurify.sanitize(html, {
		ALLOWED_TAGS: cidPictures ? [...ALLOWED_TAGS, 'img'] : ALLOWED_TAGS,
		ALLOWED_ATTR: cidPictures ? ['href', 'src', 'alt'] : ['href'],
		ALLOWED_URI_REGEXP: cidPictures ? /^(?:https?|mailto|cid):/i : /^(?:https?|mailto):/i
	});
	const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html');
	// `cid:` is for pictures only; a picture from anywhere else is dropped.
	doc.querySelectorAll('img').forEach((img) => {
		if (!/^cid:/i.test(img.getAttribute('src') ?? '')) img.remove();
	});
	doc.querySelectorAll('a[href]').forEach((a) => {
		if (/^cid:/i.test(a.getAttribute('href') ?? '')) a.removeAttribute('href');
	});
	for (const [tag, style] of Object.entries(STYLES)) {
		doc.querySelectorAll(tag).forEach((el) => el.setAttribute('style', style));
	}
	return doc.body.innerHTML;
}

/** Both parts of a message whose text is `markdown`. */
export function mailBody(markdown: string, options: MailBodyOptions = {}): MailBody {
	const { footer, cidPictures = false } = options;
	const md = markdown.trim();
	const body = sanitizeMailHtml(marked.parse(md) as string, cidPictures);
	const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
	const html = [
		'<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:720px">',
		body,
		footer ? `<hr><p style="color:#777;font-size:12px">${esc(footer)}</p>` : '',
		'</body></html>'
	].join('');
	const text = plainText(md, cidPictures) + (footer ? `\n\n—\n${footer}` : '');
	return { text, html };
}
