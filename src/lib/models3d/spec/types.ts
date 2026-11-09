/**
 * The models spec: what a 3D run makes. Guided planning writes it, the models
 * job reads it, and the report and the checker judge each model against it.
 *
 * Like the 2D asset spec it lives in the user's project, so a re-run starts
 * from the same list and the same style line.
 *
 * Model-domain code, so it lives under `src/lib/models3d/`. It borrows the id
 * rules from `src/lib/assets/spec/`, since both name files in one tree.
 */

export { ID_PATTERN } from '#lib/assets/spec/types.ts';

/** The tallest and shortest a model may be, in metres. */
export const MIN_HEIGHT_M = 0.05;
export const MAX_HEIGHT_M = 50;

/** How many models one run may make. */
export const MAX_ENTRIES = 24;

/** How long a clip may run, in seconds. */
export const MIN_CLIP_SECONDS = 0.2;
export const MAX_CLIP_SECONDS = 10;

/** A pivot name the animator can address: a JS identifier without `$`. */
export const PART_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface ModelClip {
	name: string;
	seconds: number;
	loop: boolean;
	/** Whether it may leave the floor; unset goes by its name (`AIRBORNE_CLIP`). */
	airborne?: boolean;
	/** What happens in the clip, for the animation model. */
	action: string;
}

export interface ModelEntry {
	/** A slug, unique in the spec. Assigned by the runner, never by the model. */
	id: string;
	title: string;
	/** What it looks like, for the creation model. */
	description: string;
	/** Overall height, so a set of models comes out at one scale. */
	height_m: number;
	/**
	 * Pivot names the animator relies on. Empty for a static prop.
	 */
	parts: string[];
	/** Empty when the entry has no animation stage. */
	clips: ModelClip[];
	/** Where the entry's files go: `assets/generated/model/<id>/`. */
	dir: string;
}

export interface ModelSpec {
	version: 1;
	/** One shared line (palette, low-poly level) that every creation prompt gets. */
	style: string;
	entries: ModelEntry[];
}
