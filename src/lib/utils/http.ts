/**
 * Small fetch helpers shared by the OpenAI-compatible clients
 * (`#lib/api`, `#lib/openrouter`).
 */

/** Best-effort error body of a non-2xx response ('Unknown error' if unreadable). */
export function readErrorText(res: Response): Promise<string> {
	return res.text().catch(() => 'Unknown error');
}

/** The `error` member of a refusal's JSON body; undefined when there is none or it isn't JSON. */
function errorField(body: string): unknown {
	try {
		const v: unknown = JSON.parse(body);
		return v && typeof v === 'object' ? (v as { error?: unknown }).error : undefined;
	} catch {
		return undefined;
	}
}

/** A non-empty string, or null. */
const nonEmpty = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);

/**
 * The OpenAI-style `{"error":{"message","code"}}` of a refusal (Lemonade,
 * llama-toolchest), each field null when missing or empty.
 */
export function errorBody(body: string): { message: string | null; code: string | null } {
	const e = errorField(body) as { message?: unknown; code?: unknown } | null | undefined;
	return { message: nonEmpty(e?.message), code: nonEmpty(e?.code) };
}

/** The bare `{"error": "..."}` of a refusal (ace-server), or null. */
export function errorText(body: string): string | null {
	return nonEmpty(errorField(body));
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
