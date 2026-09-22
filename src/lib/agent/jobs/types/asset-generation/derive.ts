/**
 * Turning a `submit_asset_spec` payload into a spec the job can run.
 *
 * The model proposes titles, prompts and kinds. Everything the game will later
 * reference by name — ids and output paths — is assigned here, because a model
 * that renames a thing halfway down a list leaves the project pointing at
 * something that does not exist.
 */

import type { AssetSpecEntryArg } from '$lib/agent/tools/coding';
import type { PlanAssetEntryArg } from './tools';
import {
	ASSET_KINDS,
	ID_PATTERN,
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

export interface PlanDerivePayload {
	style?: { prompt?: string; negativePrompt?: string };
	entries?: PlanAssetEntryArg[];
}

export interface PlanDeriveResult {
	spec: AssetSpec;
	/** Ids the model submitted that the shape rule rejected, verbatim. */
	rejected: string[];
}

/**
 * Build a spec from guided planning's asset stage.
 *
 * The ids come from the model because they come from the plan, and they are
 * VALIDATED rather than slugified. Slugifying would quietly turn an id the
 * plan does not use into one it does not use either — the generated file and
 * the code that loads it would disagree, and nothing would say so. A rejected
 * id is reported instead, so the stage can put it in front of someone.
 *
 * A duplicate id is also a rejection. Two entries claiming the same id means
 * the plan is ambiguous about which picture it wants, and picking one is a
 * decision this code has no basis for making.
 */
export function derivePlanSpec(
	payload: PlanDerivePayload,
	profile: NormalizeProfile
): PlanDeriveResult {
	const entries: AssetEntry[] = [];
	const rejected: string[] = [];
	const seen = new Set<string>();

	for (const raw of payload.entries ?? []) {
		const id = (raw?.id ?? '').trim();
		const prompt = (raw?.prompt ?? '').trim();
		if (prompt.length === 0) {
			rejected.push(id || '(an entry with no id)');
			continue;
		}
		if (!ID_PATTERN.test(id) || seen.has(id)) {
			rejected.push(id || '(an entry with no id)');
			continue;
		}
		seen.add(id);
		const kind = kindOf(raw.kind);
		entries.push({
			id,
			kind,
			prompt,
			out: defaultOutPath(kind, id),
			...(kind === 'texture' ? { seamless: true } : {}),
			...(typeof raw.size === 'number' && raw.size > 0 ? { size: raw.size } : {}),
			...(raw.negativePrompt?.trim() ? { negativePrompt: raw.negativePrompt.trim() } : {}),
			...(raw.notes?.trim() ? { notes: raw.notes.trim() } : {})
		});
	}

	return {
		spec: {
			version: 1,
			style: {
				prompt: (payload.style?.prompt ?? '').trim(),
				...(payload.style?.negativePrompt?.trim()
					? { negativePrompt: payload.style.negativePrompt.trim() }
					: {})
			},
			anchor: { image: DEFAULT_ANCHOR_IMAGE, recipe: DEFAULT_ANCHOR_RECIPE },
			normalize: profile,
			entries
		},
		rejected
	};
}
