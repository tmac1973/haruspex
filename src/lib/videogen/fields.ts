/**
 * Settings → Video generation's single-instance fields from before the list,
 * as an install may still have them stored: the saved list (`videoModels`) is
 * seeded from them once. Reads no settings itself, so the settings store can
 * use it.
 */

import { entryConfigKey, servedByOf } from '#lib/generation/entry.ts';
import type { VideoBackendKind, VideoModelEntry } from '#lib/videogen/types.ts';

/** The id of the entry these fields describe, kept by the entry seeded from them. */
export const LEGACY_VIDEO_ENTRY_ID = 'legacy';

/** The old fields, as stored. */
export interface LegacyVideoFields {
	videoGenBackendKind?: 'none' | 'llama-toolchest';
	videoGenToolchestBaseUrl?: string;
	videoGenToolchestApiKeyId?: string | null;
	videoGenToolchestModelId?: string;
}

/** Every old field's name. */
export const LEGACY_VIDEO_FIELDS = [
	'videoGenBackendKind',
	'videoGenToolchestBaseUrl',
	'videoGenToolchestApiKeyId',
	'videoGenToolchestModelId'
] as const satisfies readonly (keyof LegacyVideoFields)[];

/** What each backend is called where no model names it. */
export const VIDEO_BACKEND_LABEL: Record<VideoBackendKind, string> = {
	'llama-toolchest': 'llama-toolchest',
	comfyui: 'ComfyUI',
	openrouter: 'OpenRouter'
};

/** Which backend `e` runs on, for a tool's answer: "ComfyUI at asmodean:8188". */
export function videoServedBy(e: Pick<VideoModelEntry, 'backend' | 'url'>): string {
	return servedByOf(VIDEO_BACKEND_LABEL[e.backend], e.url);
}

/**
 * A name for `e` that needs no probe: the instance id, a ComfyUI model's file
 * name without its folder or extension, an OpenRouter id without its maker,
 * or "Video model" when none is chosen.
 */
export function defaultVideoName(e: Pick<VideoModelEntry, 'backend' | 'model'>): string {
	const model = e.model.trim();
	if (!model) return 'Video model';
	// OpenRouter's ids name their maker first: `google/veo-3.1` is called `veo-3.1`.
	if (e.backend === 'openrouter') return model.replace(/^.*\//, '');
	if (e.backend !== 'comfyui') return model;
	return model.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
}

/**
 * The list as the old fields describe it: none for None, else the one
 * toolchest entry. What `previous` already knew of that entry (its name, if
 * the user set it, and what a probe saw, if its config is unchanged) is kept.
 */
export function videoModelsFromFields(
	s: LegacyVideoFields,
	previous: readonly VideoModelEntry[] = []
): VideoModelEntry[] {
	if ((s.videoGenBackendKind ?? 'none') === 'none') return [];
	const model = (s.videoGenToolchestModelId ?? '').trim();
	const next: VideoModelEntry = {
		id: LEGACY_VIDEO_ENTRY_ID,
		name: defaultVideoName({ backend: 'llama-toolchest', model }),
		backend: 'llama-toolchest',
		url: (s.videoGenToolchestBaseUrl ?? '').trim(),
		keyId: s.videoGenToolchestApiKeyId ?? null,
		model,
		options: {},
		caps: null,
		capsAt: null,
		renamed: false
	};
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
