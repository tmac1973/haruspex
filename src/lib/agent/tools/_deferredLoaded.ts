/**
 * What a loaded tool family looks like in the messages (`deferred.ts`). Apart
 * from it so the loop can read it without pulling in the registry.
 */

import type { ChatMessage } from '#lib/api.ts';
import { messageText } from '#lib/api.ts';
import type { DeferredFamily } from '#lib/agent/tools/types.ts';

const OPEN = '<tools_loaded family="';

/** The first line of a `load_tools` result. */
export function loadedMarker(id: string): string {
	return `${OPEN}${id}">`;
}

/**
 * The families loaded in `messages`: a marker in what the model is sent.
 * When a turn is dropped, trimmed or summarised away, its schemas go with it,
 * and so does the family, so the next call gets them again.
 */
export function loadedFamilies(messages: ChatMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if (m.role !== 'tool') continue;
		const text = messageText(m.content);
		if (!text.startsWith(OPEN)) continue;
		const end = text.indexOf('"', OPEN.length);
		if (end > OPEN.length) ids.add(text.slice(OPEN.length, end));
	}
	return ids;
}

/** What `load_tools` returns for a family: the marker, then its schemas. */
export function familyResult(family: DeferredFamily): string {
	const fns = family.schemas.map((s) => s.function);
	return [
		loadedMarker(family.id),
		'Call these tools through use_tool, with name and arguments:',
		JSON.stringify(fns)
	].join('\n');
}

/** The deferred family a tool belongs to, when this turn defers it. */
export function deferredFamilyOf(
	name: string,
	deferred: DeferredFamily[] | undefined
): DeferredFamily | undefined {
	return deferred?.find((f) => f.schemas.some((s) => s.function.name === name));
}
