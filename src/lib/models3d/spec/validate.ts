/**
 * What is wrong with a models spec, as sentences naming the entry at fault.
 *
 * Every message carries the id, so the user can find the entry to fix.
 */

import type { ModelEntry, ModelSpec } from '#lib/models3d/spec/types.ts';
import {
	ID_PATTERN,
	MAX_CLIP_SECONDS,
	MAX_ENTRIES,
	MAX_HEIGHT_M,
	MIN_CLIP_SECONDS,
	MIN_HEIGHT_M,
	PART_PATTERN
} from '#lib/models3d/spec/types.ts';

export function validateModelSpec(spec: ModelSpec): string[] {
	const problems: string[] = [];
	if (spec.entries.length === 0) {
		problems.push('The spec lists no models to make.');
	} else if (spec.entries.length > MAX_ENTRIES) {
		problems.push(
			`The spec lists ${spec.entries.length} models; a run makes at most ${MAX_ENTRIES}.`
		);
	}
	const seen = new Set<string>();
	for (const e of spec.entries) {
		const at = e.id || '(no id)';
		if (!ID_PATTERN.test(e.id)) {
			problems.push(
				`${at}: the id must start with a letter and use only lowercase letters, digits and underscores (2-48 characters).`
			);
		}
		if (seen.has(e.id)) problems.push(`${at}: duplicate id.`);
		seen.add(e.id);
		problems.push(...entryProblems(at, e));
	}
	return problems;
}

/** What is wrong with one entry's size, parts, clips and folder. */
function entryProblems(at: string, e: ModelEntry): string[] {
	const problems: string[] = [];
	if (!(e.height_m >= MIN_HEIGHT_M && e.height_m <= MAX_HEIGHT_M)) {
		problems.push(`${at}: height_m must be between ${MIN_HEIGHT_M} and ${MAX_HEIGHT_M} metres.`);
	}

	const parts = new Set<string>();
	for (const p of e.parts) {
		if (!PART_PATTERN.test(p)) {
			problems.push(
				`${at}: part "${p}" must start with a letter and use only letters, digits and underscores.`
			);
		}
		if (parts.has(p)) problems.push(`${at}: part "${p}" is listed twice.`);
		parts.add(p);
	}

	const clips = new Set<string>();
	for (const c of e.clips) {
		if (c.name.trim().length === 0) problems.push(`${at}: a clip has no name.`);
		else if (clips.has(c.name)) problems.push(`${at}: clip "${c.name}" is listed twice.`);
		clips.add(c.name);
		if (!(c.seconds >= MIN_CLIP_SECONDS && c.seconds <= MAX_CLIP_SECONDS)) {
			problems.push(
				`${at}: clip "${c.name}" must last between ${MIN_CLIP_SECONDS} and ${MAX_CLIP_SECONDS} seconds.`
			);
		}
	}
	// The animator moves named pivots; with none there is nothing to move.
	if (e.clips.length > 0 && e.parts.length === 0) {
		problems.push(`${at}: has clips but no parts for them to move.`);
	}

	const dir = e.dir.replace(/\\/g, '/');
	if (!dir.startsWith('assets/')) {
		problems.push(`${at}: the folder "${e.dir}" is not under assets/.`);
	}
	if (dir.includes('..')) {
		problems.push(`${at}: the folder "${e.dir}" must not contain "..".`);
	}
	return problems;
}
