/**
 * Small fetch helpers shared by the OpenAI-compatible clients
 * (`#lib/api`, `#lib/openrouter`).
 */

/** Best-effort error body of a non-2xx response ('Unknown error' if unreadable). */
export function readErrorText(res: Response): Promise<string> {
	return res.text().catch(() => 'Unknown error');
}

/**
 * A configured URL as it may appear in a log or a public issue: scheme, host,
 * port and path. Userinfo (`user:pass@`), the query string (`?key=…`) and the
 * fragment go, since any of them can hold a credential.
 */
export function urlForReport(url: string): string {
	if (!url) return '';
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
	} catch {
		return '(not a valid URL)';
	}
}
