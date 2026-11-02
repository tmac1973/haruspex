/**
 * What a card's notification says when a run finds something new: the first
 * new item's label, and how many more came with it. Null when nothing is new
 * or this is the card's first result (everything in it would count as new).
 */
export function newItemsMessage<T extends Record<string, unknown>>(
	prevItems: T[] | undefined,
	nextItems: T[],
	idField: string,
	itemLabel: (item: T) => string
): string | null {
	if (!prevItems) return null;
	const seen = new Set(prevItems.map((i) => String(i[idField])));
	const fresh = nextItems.filter((i) => !seen.has(String(i[idField])));
	if (fresh.length === 0) return null;
	const first = itemLabel(fresh[0]);
	return fresh.length === 1 ? first : `${first} and ${fresh.length - 1} more`;
}
