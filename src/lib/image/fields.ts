/**
 * Settings → Image's single-backend fields as image model entries: how the
 * saved list (`imageModels`) is seeded from them, and kept in step while the
 * Settings screen still edits them. Reads no settings itself, so the settings
 * store can use it.
 */

import { entryConfigKey } from '#lib/generation/entry.ts';
import type { AppSettings } from '#lib/stores/settings.ts';
import type { ImageModelEntry } from '#lib/image/types.ts';

/** The id of the entry these fields describe, so a backend built from it is kept. */
export const LEGACY_ENTRY_ID = 'legacy';

type EntryKind = ImageModelEntry['backend'];

/** The fields that describe the entry; changing one changes it. */
export const LEGACY_IMAGE_FIELDS = [
	'imageBackendKind',
	'imageBackendBaseUrl',
	'imageComfyCheckpoint',
	'imageComfyWorkflowPath',
	'imageComfyFieldMapPath',
	'imageLocalModelId',
	'imageLemonadeBaseUrl',
	'imageLemonadeModelId',
	'imageToolchestBaseUrl',
	'imageToolchestApiKeyId',
	'imageToolchestModelId'
] as const satisfies readonly (keyof AppSettings)[];

export type LegacyImageFields = Partial<Pick<AppSettings, (typeof LEGACY_IMAGE_FIELDS)[number]>>;

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
	s: LegacyImageFields,
	kind: EntryKind
): { url: string; keyId: string | null; model: string; options: Record<string, string> } {
	switch (kind) {
		case 'comfyui':
			return {
				url: s.imageBackendBaseUrl ?? '',
				keyId: null,
				model: s.imageComfyCheckpoint ?? '',
				options: {
					workflowPath: s.imageComfyWorkflowPath ?? '',
					fieldMapPath: s.imageComfyFieldMapPath ?? ''
				}
			};
		case 'local':
			return { url: '', keyId: null, model: s.imageLocalModelId ?? '', options: {} };
		case 'lemonade':
			return {
				url: s.imageLemonadeBaseUrl ?? '',
				keyId: null,
				model: s.imageLemonadeModelId ?? '',
				options: {}
			};
		case 'llama-toolchest':
			return {
				url: s.imageToolchestBaseUrl ?? '',
				keyId: s.imageToolchestApiKeyId ?? null,
				model: s.imageToolchestModelId ?? '',
				options: {}
			};
	}
}

/** The entry `kind`'s fields describe, whether or not it is the chosen kind. */
export function entryFromFields(s: LegacyImageFields, kind: EntryKind): ImageModelEntry {
	const f = fieldsOf(s, kind);
	const model = f.model.trim();
	return {
		id: LEGACY_ENTRY_ID,
		name: defaultImageName({ backend: kind, model }),
		backend: kind,
		url: f.url.trim(),
		keyId: f.keyId,
		model,
		options: f.options,
		caps: null,
		capsAt: null,
		renamed: false
	};
}

/**
 * The saved list as the fields describe it: none for None, else the one
 * entry. What `previous` already knew of that entry (its name, if the user
 * set it, and what a probe saw, if its config is unchanged) is kept.
 */
export function imageModelsFromFields(
	s: LegacyImageFields,
	previous: readonly ImageModelEntry[] = []
): ImageModelEntry[] {
	const kind = s.imageBackendKind ?? 'none';
	if (kind === 'none') return [];
	const next = entryFromFields(s, kind);
	const was = previous.find((e) => e.id === next.id && e.backend === next.backend);
	if (!was) return [next];
	const same = entryConfigKey(was) === entryConfigKey(next);
	return [
		{
			...next,
			name: was.renamed ? was.name : next.name,
			renamed: was.renamed,
			caps: same ? was.caps : null,
			capsAt: same ? was.capsAt : null
		}
	];
}
