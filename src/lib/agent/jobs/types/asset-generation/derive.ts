/**
 * Turning a `submit_asset_spec` payload into a spec the job can run.
 *
 * The model proposes titles, prompts and kinds. Everything the game will later
 * reference by name — ids and output paths — is assigned here, because a model
 * that renames a thing halfway down a list leaves the project pointing at
 * something that does not exist.
 */

import type { AssetSpecEntryArg } from '$lib/agent/tools/coding';
import {
	ASSET_KINDS,
	type AssetEntry,
	type AssetKind,
	type AssetSpec
} from '$lib/assets/spec/types';
import {
	DEFAULT_ANCHOR_IMAGE,
	DEFAULT_ANCHOR_RECIPE,
	defaultOutPath,
	uniqueId
} from '$lib/assets/spec/paths';
import type { NormalizeProfile } from '$lib/ipc/gen/NormalizeProfile';

export interface DerivePayload {
	style?: { prompt?: string; negativePrompt?: string };
	entries?: AssetSpecEntryArg[];
}

function kindOf(raw: unknown): AssetKind {
	return ASSET_KINDS.includes(raw as AssetKind) ? (raw as AssetKind) : 'sprite';
}

/**
 * Build a spec from what the model submitted plus the run's own settings.
 *
 * `profile` is the shipped default with the job's target size applied; it is
 * fetched from Rust rather than rebuilt here so the numbers stay in one place.
 */
export function deriveSpec(payload: DerivePayload, profile: NormalizeProfile): AssetSpec {
	const taken = new Set<string>();
	const entries: AssetEntry[] = [];
	for (const raw of payload.entries ?? []) {
		const title = (raw?.title ?? '').trim();
		const prompt = (raw?.prompt ?? '').trim();
		if (title.length === 0 || prompt.length === 0) continue;
		const kind = kindOf(raw.kind);
		const id = uniqueId(title, taken);
		taken.add(id);
		entries.push({
			id,
			kind,
			prompt,
			out: defaultOutPath(kind, id),
			// A texture must tile; nothing else is asked to.
			...(kind === 'texture' ? { seamless: true } : {}),
			...(raw.negativePrompt?.trim() ? { negativePrompt: raw.negativePrompt.trim() } : {}),
			...(raw.notes?.trim() ? { notes: raw.notes.trim() } : {})
		});
	}

	return {
		version: 1,
		style: {
			prompt: (payload.style?.prompt ?? '').trim(),
			...(payload.style?.negativePrompt?.trim()
				? { negativePrompt: payload.style.negativePrompt.trim() }
				: {})
			// `model` and `loras` are left unset: a derivation has no basis for
			// pinning either, and unset means "whatever the backend is
			// configured with" rather than a choice nobody made.
		},
		// Phase 08 reads these paths, so this stage must populate them.
		anchor: { image: DEFAULT_ANCHOR_IMAGE, recipe: DEFAULT_ANCHOR_RECIPE },
		normalize: profile,
		entries
	};
}
