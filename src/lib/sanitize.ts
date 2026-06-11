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
 * attributes dispatched by markdown-actions.ts instead.
 *
 * On top of the defaults we forbid form controls (other than <button>, which
 * the code-block header needs): rendered chat content must not be able to
 * build credential-phishing forms.
 */
const FORBID_TAGS = ['form', 'input', 'select', 'textarea', 'option', 'dialog'];

export function sanitizeHtml(html: string): string {
	return DOMPurify.sanitize(html, { FORBID_TAGS });
}
