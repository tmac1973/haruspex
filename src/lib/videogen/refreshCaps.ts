/**
 * Fill in what each video model can do where no probe has said yet, so the
 * tool can route without asking every server first. A model that doesn't
 * answer stays unknown and is asked again when a clip needs it.
 */

import { videoBackendForEntry } from '#lib/videogen/index.ts';
import { saveVideoCaps, videoEntries } from '#lib/videogen/entries.ts';

export async function refreshMissingVideoCaps(): Promise<void> {
	for (const entry of videoEntries()) {
		if (entry.caps) continue;
		const backend = videoBackendForEntry(entry);
		if (!backend) continue;
		try {
			if (!(await backend.probe()).ok) continue;
			saveVideoCaps(entry.id, await backend.capabilities());
		} catch (e) {
			console.warn(`could not probe video model ${entry.name}`, e);
		}
	}
}
