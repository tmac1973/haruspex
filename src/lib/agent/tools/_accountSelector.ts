/**
 * Pick accounts by what a model calls them: the id, then the label, then the
 * address, case-insensitively for the last two; every one of `all` when no
 * selector is given. That order exists because models name an account the
 * way the user did — "my work calendar" is a label, not an id — and matching
 * only on id would make the natural phrasing fail.
 */
export function selectAccounts<T extends { id: string; label: string }>(
	all: T[],
	selector: string | undefined,
	addressOf: (account: T) => string
): T[] {
	if (!selector) return all;
	const byId = all.filter((a) => a.id === selector);
	if (byId.length > 0) return byId;
	const needle = selector.trim().toLowerCase();
	const byLabel = all.filter((a) => a.label.trim().toLowerCase() === needle);
	if (byLabel.length > 0) return byLabel;
	return all.filter((a) => addressOf(a).trim().toLowerCase() === needle);
}
