/**
 * A models spec from what a model submitted.
 *
 * Two sources, as for the 2D spec: the models job's own spec stage, which has
 * no plan and lets the runner make each id from a title, and guided planning's
 * models stage, whose ids come from the plan and are checked, never changed.
 */

import {
	ID_PATTERN,
	LOOPING_CLIP,
	type ModelClip,
	type ModelEntry,
	type ModelSpec
} from '#lib/models3d/spec/types.ts';
import { modelDir } from '#lib/models3d/spec/paths.ts';
import { parsedOrNaN, trimmed } from '#lib/utils/coerce.ts';

/** The objects in a submitted list; anything else in it is dropped. */
export function objects(v: unknown): Record<string, unknown>[] {
	return Array.isArray(v)
		? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
		: [];
}

function clip(c: Record<string, unknown>): ModelClip {
	const name = trimmed(c.name);
	return {
		name,
		seconds: parsedOrNaN(c.seconds),
		loop: typeof c.loop === 'boolean' ? c.loop : LOOPING_CLIP.test(name),
		action: trimmed(c.action)
	};
}

/**
 * One submitted entry under the id the caller chose. Whatever is still wrong
 * is left for `validateModelSpec` to name.
 */
export function modelEntryOf(e: Record<string, unknown>, id: string): ModelEntry {
	return {
		id,
		title: trimmed(e.title),
		description: trimmed(e.description),
		height_m: parsedOrNaN(e.height_m),
		parts: Array.isArray(e.parts) ? e.parts.map(trimmed).filter((p) => p.length > 0) : [],
		clips: objects(e.clips).map(clip),
		dir: modelDir(id)
	};
}

export interface PlanModelDeriveResult {
	spec: ModelSpec;
	/** Ids the model submitted that the shape rule refused, or duplicates, verbatim. */
	rejected: string[];
}

/**
 * A spec from guided planning's models stage.
 *
 * The ids are the plan's, so they are checked rather than slugified: a
 * slugified id is one the plan does not use, and the code that loads the GLB
 * would disagree with the file. A refused id, or a second entry with the same
 * id, is reported instead, as `derivePlanSpec` does for 2D art.
 */
export function derivePlanModelSpec(payload: Record<string, unknown>): PlanModelDeriveResult {
	const rejected: string[] = [];
	const seen = new Set<string>();
	const entries: ModelEntry[] = [];
	for (const raw of objects(payload.entries)) {
		const id = trimmed(raw.id);
		if (!ID_PATTERN.test(id) || seen.has(id)) {
			rejected.push(id || '(an entry with no id)');
			continue;
		}
		seen.add(id);
		entries.push(modelEntryOf(raw, id));
	}
	return { spec: { version: 1, style: trimmed(payload.style), entries }, rejected };
}
