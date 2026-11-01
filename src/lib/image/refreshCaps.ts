/**
 * Ask each saved image model that no probe has answered for yet what it can
 * do, once at start: a setup saved before the list existed has none, and the
 * tools and the prompt read what each entry keeps rather than asking every
 * server on every turn.
 */

import { backendForEntry } from '#lib/image/index.ts';
import { imageEntries, saveImageCaps } from '#lib/image/entries.ts';
import { errMessage } from '#lib/utils/error.ts';

export async function refreshMissingImageCaps(): Promise<void> {
	for (const entry of imageEntries().filter((e) => e.caps === null)) {
		const backend = backendForEntry(entry);
		if (!backend) continue;
		try {
			// One that doesn't answer stays unknown, which the tools treat as able.
			if (!(await backend.probe()).ok) continue;
			saveImageCaps(entry.id, await backend.capabilities());
		} catch (e) {
			console.warn(`Could not ask ${entry.name} what it can do: ${errMessage(e)}`);
		}
	}
}
