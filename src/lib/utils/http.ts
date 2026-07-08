/**
 * Small fetch helpers shared by the OpenAI-compatible clients
 * (`$lib/api`, `$lib/openrouter`).
 */

/** Best-effort error body of a non-2xx response ('Unknown error' if unreadable). */
export function readErrorText(res: Response): Promise<string> {
	return res.text().catch(() => 'Unknown error');
}
