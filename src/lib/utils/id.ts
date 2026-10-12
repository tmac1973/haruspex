/**
 * A fresh id for a settings item (an account, an MCP server). A UUID where the
 * webview has `crypto.randomUUID` — it is missing outside a secure context —
 * else `<prefix>-<time>-<random>`.
 */
export function newId(prefix: string): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
