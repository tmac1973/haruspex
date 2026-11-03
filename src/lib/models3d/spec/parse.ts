/**
 * Reading a models spec off disk.
 *
 * Tolerant like the asset spec: a malformed file yields errors rather than
 * throwing, and a missing optional field takes its default. What a spec says
 * wrongly is validation's job.
 */

import type { ModelClip, ModelEntry, ModelSpec } from '#lib/models3d/spec/types.ts';
import { LOOPING_CLIP } from '#lib/models3d/spec/types.ts';
import { modelDir } from '#lib/models3d/spec/paths.ts';

export type ModelParseResult = { spec: ModelSpec } | { errors: string[] };

function str(v: unknown, fallback = ''): string {
	return typeof v === 'string' ? v : fallback;
}

/** NaN when absent, so validation reports it rather than a quiet zero. */
function num(v: unknown): number {
	return typeof v === 'number' ? v : NaN;
}

function strings(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function clip(raw: unknown): ModelClip | null {
	if (!raw || typeof raw !== 'object') return null;
	const c = raw as Record<string, unknown>;
	const name = str(c.name);
	return {
		name,
		seconds: num(c.seconds),
		// Locomotion and idles cycle; a one-shot like "attack" does not.
		loop: typeof c.loop === 'boolean' ? c.loop : LOOPING_CLIP.test(name),
		action: str(c.action)
	};
}

function entry(raw: unknown): ModelEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const e = raw as Record<string, unknown>;
	const id = str(e.id);
	return {
		id,
		title: str(e.title),
		description: str(e.description),
		height_m: num(e.height_m),
		parts: strings(e.parts),
		clips: Array.isArray(e.clips)
			? e.clips.map(clip).filter((c): c is ModelClip => c !== null)
			: [],
		dir: typeof e.dir === 'string' && e.dir.length > 0 ? e.dir : modelDir(id)
	};
}

/**
 * Parse a models spec. Returns errors only when the file is not a spec at all,
 * so validation can report every problem in one pass.
 */
export function parseModelSpec(json: string): ModelParseResult {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch (e) {
		return { errors: [`The spec is not valid JSON — ${e instanceof Error ? e.message : e}`] };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { errors: ['The spec must be a JSON object.'] };
	}
	const o = raw as Record<string, unknown>;
	if (!Array.isArray(o.entries)) {
		return { errors: ['The spec has no "entries" array.'] };
	}
	return {
		spec: {
			version: 1,
			style: str(o.style),
			entries: o.entries.map(entry).filter((e): e is ModelEntry => e !== null)
		}
	};
}
