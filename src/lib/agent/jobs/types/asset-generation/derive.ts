/**
 * Turning a `submit_asset_spec` payload into a spec the job can run.
 *
 * The model proposes titles, prompts and kinds. Everything the game will later
 * reference by name — ids and output paths — is assigned here, because a model
 * that renames a thing halfway down a list leaves the project pointing at
 * something that does not exist.
 */

import type { AssetSpecEntryArg, AssetSpecTransitionArg } from '#lib/agent/tools/coding.ts';
import type {
	PlanAssetEntryArg,
	PlanAssetTransitionArg
} from '#lib/agent/jobs/types/asset-generation/tools.ts';
import {
	ASSET_KINDS,
	ID_PATTERN,
	type AssetEntry,
	type AssetKind,
	type AssetSpec,
	type TransitionEntry
} from '#lib/assets/spec/types.ts';
import {
	DEFAULT_ANCHOR_IMAGE,
	DEFAULT_ANCHOR_RECIPE,
	defaultOutPath,
	defaultTransitionOut,
	uniqueId
} from '#lib/assets/spec/paths.ts';
import type { NormalizeProfile } from '#lib/ipc/gen/NormalizeProfile.ts';

export interface DerivePayload {
	style?: { prompt?: string; negativePrompt?: string };
	/** The sheet the model chose as the style anchor. */
	anchorSheet?: string;
	entries?: AssetSpecEntryArg[];
	transitions?: AssetSpecTransitionArg[];
}

/**
 * Transition sets from what the model submitted. `resolve` turns a material
 * as the model named it into an entry id; one it can't resolve is kept as
 * written, so validation names it and the retry asks for it to be fixed.
 * `idFor` gives the set's id from its submission and a fallback title.
 */
function transitionsOf(
	raw: unknown,
	resolve: (name: string) => string,
	idFor: (t: { title?: string; id?: string }, fallback: string) => string
): TransitionEntry[] {
	const out: TransitionEntry[] = [];
	for (const t of Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []) {
		const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
		const a = text(t?.a);
		if (!a) continue;
		const view = t.view === 'side' ? 'side' : 'top';
		const b = text(t.b);
		const cap = text(t.cap);
		const fallback = view === 'top' ? `${a} to ${b}` : `${a} platform`;
		const id = idFor({ title: text(t.title), id: text(t.id) }, fallback);
		out.push({
			id,
			view,
			a: resolve(a),
			...(view === 'top' && b ? { b: resolve(b) } : {}),
			...(view === 'side' && cap ? { cap: resolve(cap) } : {}),
			out: defaultTransitionOut(id)
		});
	}
	return out;
}

/** The derivation's sets: materials named by title, ids made from titles. */
function titledTransitions(
	raw: unknown,
	byTitle: Map<string, string>,
	taken: Set<string>
): TransitionEntry[] {
	return transitionsOf(
		raw,
		(name) => byTitle.get(name.toLowerCase()) ?? name,
		(t, fallback) => {
			const id = uniqueId(t.title || fallback, taken);
			taken.add(id);
			return id;
		}
	);
}

/** A spec's `transitions`, left out when there are none. */
function withTransitions(sets: TransitionEntry[]): { transitions?: TransitionEntry[] } {
	return sets.length ? { transitions: sets } : {};
}

function kindOf(raw: unknown): AssetKind {
	return ASSET_KINDS.includes(raw as AssetKind) ? (raw as AssetKind) : 'sprite';
}

/**
 * A sheet name the spec will accept, or nothing.
 *
 * Slugified rather than rejected: "Small items" is a perfectly good group, and
 * failing the whole derivation over its capital letter would be absurd. A
 * texture's is dropped — it fills its own frame.
 */
export function sheetName(raw: unknown, kind: AssetKind): string | undefined {
	if (kind === 'texture' || typeof raw !== 'string') return undefined;
	const slug = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 48);
	return ID_PATTERN.test(slug) ? slug : undefined;
}

/**
 * Used when a derivation submits no style line at all. Neutral on purpose:
 * medium and line only, no colours (a colour scheme tints every asset). The
 * style line adds coherence; losing a whole set of art because it is missing
 * would be far worse than this.
 */
export const FALLBACK_STYLE = 'pixel art, flat shading, clean dark outlines';

/**
 * The style as submitted. A model may send the line as a plain string where
 * the schema asks for `{ prompt }` — the obvious intent — and the tool's
 * coercion cannot make an object out of prose. That once came through as an
 * empty style, failed validation, and a chain went to coding with no art.
 */
export function styleOf(raw: unknown): {
	prompt: string;
	negativePrompt?: string;
	fallback: boolean;
} {
	const obj =
		typeof raw === 'string'
			? { prompt: raw }
			: raw && typeof raw === 'object'
				? (raw as { prompt?: unknown; negativePrompt?: unknown })
				: {};
	const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim() : '';
	const negative = typeof obj.negativePrompt === 'string' ? obj.negativePrompt.trim() : '';
	return {
		prompt: prompt || FALLBACK_STYLE,
		...(negative ? { negativePrompt: negative } : {}),
		fallback: prompt.length === 0
	};
}

/** The anchor sheet the model named, when it names a sheet that exists. */
function anchorSheetOf(raw: unknown, entries: AssetEntry[]): { sheet?: string } {
	const name = sheetName(raw, 'sprite');
	return name && entries.some((e) => e.sheet === name) ? { sheet: name } : {};
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
	/** Each entry's id by its title, lowercased: transitions name materials so. */
	const byTitle = new Map<string, string>();
	const style = styleOf(payload.style);
	for (const raw of Array.isArray(payload.entries) ? payload.entries : []) {
		const title = (raw?.title ?? '').trim();
		const prompt = (raw?.prompt ?? '').trim();
		if (title.length === 0 || prompt.length === 0) continue;
		const kind = kindOf(raw.kind);
		const id = uniqueId(title, taken);
		taken.add(id);
		byTitle.set(title.toLowerCase(), id);
		const sheet = sheetName(raw.sheet, kind);
		entries.push({
			id,
			kind,
			...(sheet ? { sheet } : {}),
			prompt,
			out: defaultOutPath(kind, id),
			// A texture must tile; nothing else is asked to.
			...(kind === 'texture' ? { seamless: true } : {}),
			...(raw.negativePrompt?.trim() ? { negativePrompt: raw.negativePrompt.trim() } : {}),
			...(raw.notes?.trim() ? { notes: raw.notes.trim() } : {})
		});
	}

	const transitions = titledTransitions(payload.transitions, byTitle, taken);

	return {
		version: 1,
		style: {
			prompt: style.prompt,
			...(style.negativePrompt ? { negativePrompt: style.negativePrompt } : {})
			// `model` and `loras` are left unset: a derivation has no basis for
			// pinning either, and unset means "whatever the backend is
			// configured with" rather than a choice nobody made.
		},
		// Phase 08 reads these paths, so this stage must populate them.
		anchor: {
			image: DEFAULT_ANCHOR_IMAGE,
			recipe: DEFAULT_ANCHOR_RECIPE,
			...anchorSheetOf(payload.anchorSheet, entries)
		},
		normalize: profile,
		entries,
		...withTransitions(transitions)
	};
}

export interface PlanDerivePayload {
	style?: { prompt?: string; negativePrompt?: string };
	entries?: PlanAssetEntryArg[];
	transitions?: PlanAssetTransitionArg[];
	anchorSheet?: string;
	/** The pixel size the plan draws its art at. */
	targetSize?: number;
}

/** A target size worth honouring: a sprite edge, not a typo. */
export function planTargetSize(raw: unknown): number | undefined {
	return typeof raw === 'number' && Number.isInteger(raw) && raw >= 8 && raw <= 256
		? raw
		: undefined;
}

export interface PlanDeriveResult {
	spec: AssetSpec;
	/** Ids the model submitted that the shape rule rejected, verbatim. */
	rejected: string[];
	/** True when no style line was submitted and `FALLBACK_STYLE` stands in. */
	styleFallback: boolean;
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
	const style = styleOf(payload.style);
	const rejected: string[] = [];
	const seen = new Set<string>();

	// Anything but a list is not a list of entries. A JSON string here (a model
	// stringifying the array) was once iterated character by character.
	const list = Array.isArray(payload.entries) ? payload.entries : [];
	for (const raw of list) {
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
		const sheet = sheetName(raw.sheet, kind);
		entries.push({
			id,
			kind,
			...(sheet ? { sheet } : {}),
			prompt,
			out: defaultOutPath(kind, id),
			...(kind === 'texture' ? { seamless: true } : {}),
			...(typeof raw.size === 'number' && raw.size > 0 ? { size: raw.size } : {}),
			...(raw.negativePrompt?.trim() ? { negativePrompt: raw.negativePrompt.trim() } : {}),
			...(raw.notes?.trim() ? { notes: raw.notes.trim() } : {})
		});
	}

	// Ids are the plan's, used as given; a set's own id is checked the same way.
	const transitions = transitionsOf(
		payload.transitions,
		(name) => name,
		(t, fallback) => {
			const id = t.id && ID_PATTERN.test(t.id) && !seen.has(t.id) ? t.id : uniqueId(fallback, seen);
			seen.add(id);
			return id;
		}
	);

	return {
		spec: {
			version: 1,
			style: {
				prompt: style.prompt,
				...(style.negativePrompt ? { negativePrompt: style.negativePrompt } : {})
			},
			anchor: {
				image: DEFAULT_ANCHOR_IMAGE,
				recipe: DEFAULT_ANCHOR_RECIPE,
				...anchorSheetOf(payload.anchorSheet, entries)
			},
			normalize: {
				...profile,
				target_size: planTargetSize(payload.targetSize) ?? profile.target_size
			},
			entries,
			...withTransitions(transitions)
		},
		rejected,
		styleFallback: style.fallback
	};
}
