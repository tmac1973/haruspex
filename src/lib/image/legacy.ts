/**
 * The entry Settings → Image describes today: `imageBackendKind` and that
 * kind's address, key and model fields. Every backend is built from an entry
 * (`#lib/generation/entry.ts`); until the settings keep a list of them, this
 * one stands in for it.
 */

import { getSettings } from '#lib/stores/settings.ts';
import type { AppSettings } from '#lib/stores/settings.ts';
import type { ImageBackendKind, ImageModelEntry } from '#lib/image/types.ts';
import type { ImageJobHandle } from '#lib/image/backend.ts';
import { toolchestKeyFor } from '#lib/toolchest/models.ts';

/** Its id, the same on every read, so a backend built from it is kept. */
export const LEGACY_ENTRY_ID = 'legacy';

type EntryKind = ImageModelEntry['backend'];

/** What each backend is called where no model names it. */
export const IMAGE_BACKEND_LABEL: Record<EntryKind, string> = {
	comfyui: 'ComfyUI',
	local: 'Bundled engine',
	lemonade: 'Lemonade',
	'llama-toolchest': 'llama-toolchest'
};

/**
 * A name for `e` that needs no probe: the instance or catalogue id, a ComfyUI
 * checkpoint's file name without its folder or extension, or the backend's
 * label when no model is chosen.
 */
export function defaultImageName(e: Pick<ImageModelEntry, 'backend' | 'model'>): string {
	const model = e.model.trim();
	if (!model) return IMAGE_BACKEND_LABEL[e.backend];
	if (e.backend !== 'comfyui') return model;
	return model.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
}

/** The fields a kind's address, key and model live in. */
function fieldsOf(
	s: AppSettings,
	kind: EntryKind
): { url: string; keyId: string | null; model: string; options: Record<string, string> } {
	switch (kind) {
		case 'comfyui':
			return {
				url: s.imageBackendBaseUrl,
				keyId: null,
				model: s.imageComfyCheckpoint,
				options: {
					workflowPath: s.imageComfyWorkflowPath ?? '',
					fieldMapPath: s.imageComfyFieldMapPath ?? ''
				}
			};
		case 'local':
			return { url: '', keyId: null, model: s.imageLocalModelId, options: {} };
		case 'lemonade':
			return {
				url: s.imageLemonadeBaseUrl,
				keyId: null,
				model: s.imageLemonadeModelId,
				options: {}
			};
		case 'llama-toolchest':
			return {
				url: s.imageToolchestBaseUrl,
				keyId: s.imageToolchestApiKeyId,
				model: s.imageToolchestModelId,
				options: {}
			};
	}
}

/** The entry `kind`'s settings fields describe, whether or not it is the chosen kind. */
export function legacyEntryFor(kind: EntryKind): ImageModelEntry {
	const f = fieldsOf(getSettings(), kind);
	const model = (f.model ?? '').trim();
	return {
		id: LEGACY_ENTRY_ID,
		name: defaultImageName({ backend: kind, model }),
		backend: kind,
		url: (f.url ?? '').trim(),
		keyId: f.keyId ?? null,
		model,
		options: f.options,
		caps: null,
		capsAt: null,
		renamed: false
	};
}

/** The chosen kind's entry, or null when Settings → Image is None. */
export function legacyImageEntry(): ImageModelEntry | null {
	const kind: ImageBackendKind = getSettings().imageBackendKind;
	return kind === 'none' ? null : legacyEntryFor(kind);
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
 * The entry a job `handle` was sent for, for `resume`: the one with its id
 * (Settings → Image's, for now), or one made from the handle alone when that
 * is gone. Either way `resume` asks the server and key the handle names.
 */
export function entryForHandle(handle: ImageJobHandle): ImageModelEntry | null {
	if (handle.backend === 'none') return null;
	const known = legacyEntryFor(handle.backend);
	if (!handle.entryId || handle.entryId === known.id) return known;
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
