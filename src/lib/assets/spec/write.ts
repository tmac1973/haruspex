/**
 * Writing a spec back to disk.
 *
 * Keys in a fixed order with two-space indentation, so a job that rewrites the
 * file — the anchor stage writes the palette back into it — produces a minimal
 * diff rather than a reordered file the user has to read in full to trust.
 */

import type { AssetEntry, AssetSpec } from './types';

/** Drop `undefined` members so they do not become `null` in JSON. */
function defined<T extends object>(o: T): Partial<T> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function orderedEntry(e: AssetEntry): Record<string, unknown> {
	return defined({
		id: e.id,
		kind: e.kind,
		prompt: e.prompt,
		negativePrompt: e.negativePrompt,
		out: e.out,
		size: e.size,
		seamless: e.seamless,
		seed: e.seed,
		notes: e.notes
	});
}

export function renderAssetSpec(spec: AssetSpec): string {
	const ordered = {
		// The user's own keys first: they are annotations about the file, and
		// burying them under a hundred entries makes them invisible.
		...(spec.unknown ?? {}),
		version: spec.version,
		style: defined({
			prompt: spec.style.prompt,
			negativePrompt: spec.style.negativePrompt,
			model: spec.style.model,
			loras: spec.style.loras
		}),
		anchor: { image: spec.anchor.image, recipe: spec.anchor.recipe },
		normalize: spec.normalize,
		entries: spec.entries.map(orderedEntry)
	};
	return `${JSON.stringify(ordered, null, 2)}\n`;
}
