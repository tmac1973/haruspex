import DOMPurify from 'dompurify';

/**
 * Single sanitization profile for every piece of LLM- or web-derived HTML
 * that reaches the DOM via `{@html}` (rendered markdown, sandbox HTML
 * artifacts). The model's output is not trusted: fetched pages and search
 * snippets flow into its context, so a prompt-injecting page can get
 * arbitrary HTML echoed into a reply — and this webview has full Tauri IPC
 * access.
 *
 * DOMPurify's defaults already strip <script>, inline event handlers and
 * javascript: URIs. Interactive UI inside rendered markdown (copy/paste/run
 * buttons) therefore must not use inline handlers — it uses `data-action`
 * attributes dispatched by markdownActions.ts instead.
 *
 * On top of the defaults we forbid form controls (other than <button>, which
 * the code-block header needs): rendered chat content must not be able to
 * build credential-phishing forms.
 */
const FORBID_TAGS = ['form', 'input', 'select', 'textarea', 'option', 'dialog'];

/**
 * DOMPurify's default URI allowlist does not include our custom schemes, so
 * `haruspex-img:` in an `<img src>` would be stripped and every cached image
 * would silently vanish, and the same for `haruspex-audio:` in an `<audio>`.
 * This is DOMPurify's default expression with those two schemes added; their
 * Windows forms (`http://haruspex-img.localhost/…`) need no entry because
 * they are already plain http.
 *
 * Adding a scheme here is not a licence to add more: everything else the model
 * can write stays on the default list.
 */
const ALLOWED_URI_REGEXP =
	/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|haruspex-img|haruspex-audio):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

export function sanitizeHtml(html: string): string {
	return DOMPurify.sanitize(html, { FORBID_TAGS, ALLOWED_URI_REGEXP });
}
