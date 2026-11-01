/**
 * The image models Settings keeps (`imageModels`), each one model on one
 * server, and what callers ask of them: the list, the first, the one a job
 * was sent for, and the key a call to one sends. A backend is built from an
 * entry (`#lib/image/registry.ts`).
 *
 * Settings → Image still edits its single-backend fields, which keep the list
 * in step (`#lib/image/fields.ts`), so for now it holds one entry at most.
 */

import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import type { ImageBackendCapabilities, ImageModelEntry } from '#lib/image/types.ts';
import type { ImageJobHandle } from '#lib/image/backend.ts';
import { toolchestKeyFor } from '#lib/toolchest/models.ts';
import {
	LEGACY_ENTRY_ID,
	defaultImageName,
	entryFromFields,
	imageModelsFromFields
} from '#lib/image/fields.ts';

export { IMAGE_BACKEND_LABEL, LEGACY_ENTRY_ID, defaultImageName } from '#lib/image/fields.ts';

/**
 * The image models, in the order they are tried. While Settings → Image edits
 * its single-backend fields, those say what the list holds, and the saved list
 * adds what was learned of each entry since (its name, what a probe saw).
 */
export function imageEntries(): ImageModelEntry[] {
	const s = getSettings();
	return imageModelsFromFields(s, Array.isArray(s.imageModels) ? s.imageModels : []);
}

/** The first saved image model, or null when there is none. */
export function firstImageEntry(): ImageModelEntry | null {
	return imageEntries()[0] ?? null;
}

/**
 * The entry `kind`'s Settings → Image fields describe, whether or not it is
 * the chosen kind: what the Settings screen probes and installs into.
 */
export function legacyEntryFor(kind: ImageModelEntry['backend']): ImageModelEntry {
	return entryFromFields(getSettings(), kind);
}

/**
 * Remember what a probe of entry `id` said it can do, so the tools and the
 * prompt can say so without asking every server first. Nothing is written
 * when it is what was already kept.
 */
export function saveImageCaps(id: string, caps: ImageBackendCapabilities): void {
	const list = getSettings().imageModels;
	if (!Array.isArray(list)) return;
	const at = list.findIndex((e) => e.id === id);
	if (at < 0 || JSON.stringify(list[at].caps) === JSON.stringify(caps)) return;
	const next = list.map((e, i) =>
		i === at ? { ...e, caps: structuredClone(caps), capsAt: Date.now() } : e
	);
	updateSettings({ imageModels: next });
}

/**
 * The key a ComfyUI or Lemonade entry without a named key sends: the one
 * Settings keeps inline where no secret store works, else empty, and Rust
 * falls back to the stored secret.
 */
export function inlineKeyFor(backend: 'comfyui' | 'lemonade'): string {
	const s = getSettings();
	return (backend === 'comfyui' ? s.imageBackendApiKey : s.imageLemonadeApiKey) ?? '';
}

/** The key a call for `e` sends: its named key's value, else the inline one above. */
export async function entryApiKey(e: ImageModelEntry): Promise<string> {
	if (e.keyId) return toolchestKeyFor(e.keyId);
	return e.backend === 'comfyui' || e.backend === 'lemonade' ? inlineKeyFor(e.backend) : '';
}

/**
 * The entry a job `handle` was sent for, for `resume`: the saved one with its
 * id; for a handle from before entries, the one Settings → Image's fields for
 * its backend describe; else one made from the handle alone. Either way
 * `resume` asks the server and key the handle names.
 */
export function entryForHandle(handle: ImageJobHandle): ImageModelEntry | null {
	if (handle.backend === 'none') return null;
	const saved = imageEntries().find((e) => e.id === handle.entryId && e.backend === handle.backend);
	if (saved) return saved;
	if (!handle.entryId || handle.entryId === LEGACY_ENTRY_ID) {
		return legacyEntryFor(handle.backend);
	}
	return {
		id: handle.entryId,
		name: defaultImageName({ backend: handle.backend, model: handle.model }),
		backend: handle.backend,
		url: handle.baseUrl,
		keyId: handle.extra?.keyId ?? null,
		model: handle.model,
		options: {},
		caps: null,
		capsAt: null,
		renamed: false
	};
}
