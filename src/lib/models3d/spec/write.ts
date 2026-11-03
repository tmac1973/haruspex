/**
 * Writing a models spec back to disk.
 *
 * Keys in a fixed order with two-space indentation, like `renderAssetSpec`,
 * so a job that rewrites the file produces a minimal diff.
 */

import type { ModelClip, ModelEntry, ModelSpec } from '#lib/models3d/spec/types.ts';

function orderedClip(c: ModelClip): Record<string, unknown> {
	return { name: c.name, seconds: c.seconds, loop: c.loop, action: c.action };
}

function orderedEntry(e: ModelEntry): Record<string, unknown> {
	return {
		id: e.id,
		title: e.title,
		description: e.description,
		height_m: e.height_m,
		parts: e.parts,
		clips: e.clips.map(orderedClip),
		dir: e.dir
	};
}

export function renderModelSpec(spec: ModelSpec): string {
	const ordered = {
		version: spec.version,
		style: spec.style,
		entries: spec.entries.map(orderedEntry)
	};
	return `${JSON.stringify(ordered, null, 2)}\n`;
}
