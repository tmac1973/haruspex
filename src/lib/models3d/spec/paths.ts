/**
 * Where the models spec, its report and each model's files live, relative to
 * the working directory.
 *
 * One place, because the job writes these, the checker reads them and the
 * report links them. A convention written down twice is a convention that
 * drifts.
 */

import type { ModelEntry } from '#lib/models3d/spec/types.ts';
import { slugify } from '#lib/assets/spec/paths.ts';

export { slugify, uniqueId } from '#lib/assets/spec/paths.ts';

export const DEFAULT_MODELS_SPEC_PATH = 'assets/haruspex-models.json';

/** The run's report, written beside the spec. */
export const REPORT_NAME = 'REPORT-models.md';

/** Where an entry's files go, with the trailing slash. */
export function modelDir(id: string): string {
	return `assets/generated/model/${id}/`;
}

export interface ModelFiles {
	/** The build module the creation stage writes. */
	build: string;
	/** The animation module the animate stage writes. */
	anim: string;
	glb: string;
	/** The views the checker renders of the model. */
	sheet: string;
	/** The motion sheet for one clip. */
	clipSheet: (clip: string) => string;
}

/** Every file an entry owns, under its `dir`. */
export function modelFiles(entry: Pick<ModelEntry, 'id' | 'dir'>): ModelFiles {
	// A dir written by hand may lack the slash; the paths must not run together.
	const dir = entry.dir.endsWith('/') ? entry.dir : `${entry.dir}/`;
	return {
		build: `${dir}${entry.id}.js`,
		anim: `${dir}${entry.id}.anim.js`,
		glb: `${dir}${entry.id}.glb`,
		sheet: `${dir}sheet.png`,
		clipSheet: (clip) => `${dir}clip-${slugify(clip)}.png`
	};
}
