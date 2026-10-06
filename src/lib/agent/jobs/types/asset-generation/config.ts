/** Asset-generation `type_config` JSON shape. */

import { parseModelColumns, type ModelColumns } from '../../chainModel';
import { DEFAULT_SPEC_PATH } from '#lib/assets/spec/paths.ts';

/** Which checkpoints the run stops at. */
export type AssetRunMode = 'attended' | 'unattended';

const RUN_MODES: readonly AssetRunMode[] = ['attended', 'unattended'];

export const RUN_MODE_LABELS: Record<AssetRunMode, string> = {
	attended: 'Attended',
	unattended: 'Unattended'
};

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_ANCHOR_ATTEMPTS = 5;
export const DEFAULT_CONCURRENCY = 1;
/** On by default, but it only runs when the job's model can actually see. */
export const DEFAULT_VISION_JUDGE = true;
/**
 * 64, not 32. Measured on Ming-Image sheets (phase 17): items survive 32 px,
 * but characters, vehicles and buildings turn to mush; 64 holds up for
 * everything tested. 32 stays available per spec and per entry.
 */
export const DEFAULT_TARGET_SIZE = 64;
/** Tiles drawn per code-drawn texture, unless the job says otherwise. */
export const DEFAULT_TEXTURE_VARIANTS = 4;
export const MAX_TEXTURE_VARIANTS = 8;
export const MIN_TARGET_SIZE = 8;
export const MAX_TARGET_SIZE = 512;
/** Mirrors the Rust clamp; the anchor sheet obeys it too. */
export const MAX_GENERATION_EDGE = 1024;

export interface AssetGenerationConfig {
	/** The spec file, relative to working_dir. null = the default path. */
	spec_path: string | null;
	/** What to make, when there is no spec file yet. */
	description: string | null;
	/**
	 * `unattended` auto-accepts the style anchor. Anything unrecognised reads
	 * as `attended`: a malformed config must not silently make a run
	 * unattended, which is the same rule guided planning follows.
	 */
	run_mode: AssetRunMode;
	/**
	 * Output edge in pixels. The parser clamps to a power of two in 8-512 so a
	 * hand-edited config still runs; the editor rejects one before saving, so
	 * a user typing 30 is told rather than silently given 32.
	 */
	target_size: number | null;
	/** Per-entry generation retries. */
	max_attempts: number | null;
	/**
	 * How many times the style anchor may be regenerated.
	 *
	 * Separate from `max_attempts` deliberately: they answer different
	 * questions, and one knob for both would mean raising per-asset retries
	 * also raised how many times the approval modal can be re-rolled.
	 */
	anchor_attempts: number | null;
	/** Simultaneous backend requests. A box with several GPUs is why. */
	concurrency: number | null;
	/** Score each asset against the anchor with a vision model. */
	vision_judge: boolean | null;
	/** Use git at all. */
	use_git: boolean | null;
	/**
	 * Draw textures in code from a recipe instead of with the image model.
	 * Null (an older job) means no; new jobs and chains set it true.
	 */
	code_textures: boolean | null;
	/** Tiles per code-drawn texture, 1 to 8. */
	texture_variants: number | null;
	/**
	 * An autonomous-coding configuration to start after this job, carried the
	 * way guided planning carries its own. Null for a standalone run.
	 */
	coding_run: Record<string, unknown> | null;
	/**
	 * Whether a run started by hand still starts the coding run. A chained run
	 * always does. Null means yes: re-running a chain's asset stage by hand is
	 * how a broken chain is resumed.
	 */
	hand_off: boolean | null;
	/** Set by a chain: the planning job's name, for the coding job's name. */
	chain_base_name: string | null;
	/**
	 * Set by a chain: the coding stage's model as the planning job resolved it.
	 * All-null columns are valid and mean the Settings model.
	 */
	chain_coding_model: ModelColumns | null;
}

function clampInt(v: unknown, lo: number, hi: number): number | null {
	return typeof v === 'number' && Number.isFinite(v)
		? Math.min(hi, Math.max(lo, Math.round(v)))
		: null;
}

function optionalBool(v: unknown): boolean | null {
	return typeof v === 'boolean' ? v : null;
}

/** Nearest power of two, clamped. A hand-edited 30 becomes 32 rather than failing. */
function clampPowerOfTwo(v: unknown): number | null {
	const n = clampInt(v, MIN_TARGET_SIZE, MAX_TARGET_SIZE);
	if (n === null) return null;
	const exp = Math.round(Math.log2(n));
	return Math.min(MAX_TARGET_SIZE, Math.max(MIN_TARGET_SIZE, 2 ** exp));
}

export function parseAssetGenerationConfig(json: string | null): AssetGenerationConfig {
	let raw: Record<string, unknown> = {};
	if (json) {
		try {
			const parsed: unknown = JSON.parse(json);
			if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
		} catch {
			// Malformed config behaves like no config.
		}
	}
	return {
		spec_path:
			typeof raw.spec_path === 'string' && raw.spec_path.trim().length > 0
				? raw.spec_path.trim()
				: null,
		description:
			typeof raw.description === 'string' && raw.description.trim().length > 0
				? raw.description
				: null,
		run_mode: RUN_MODES.includes(raw.run_mode as AssetRunMode)
			? (raw.run_mode as AssetRunMode)
			: 'attended',
		target_size: clampPowerOfTwo(raw.target_size),
		max_attempts: clampInt(raw.max_attempts, 1, 10),
		anchor_attempts: clampInt(raw.anchor_attempts, 1, 10),
		concurrency: clampInt(raw.concurrency, 1, 8),
		vision_judge: optionalBool(raw.vision_judge),
		use_git: optionalBool(raw.use_git),
		code_textures: optionalBool(raw.code_textures),
		texture_variants: clampInt(raw.texture_variants, 1, MAX_TEXTURE_VARIANTS),
		coding_run:
			raw.coding_run && typeof raw.coding_run === 'object' && !Array.isArray(raw.coding_run)
				? (raw.coding_run as Record<string, unknown>)
				: null,
		hand_off: optionalBool(raw.hand_off),
		chain_base_name:
			typeof raw.chain_base_name === 'string' && raw.chain_base_name.trim()
				? raw.chain_base_name.trim()
				: null,
		chain_coding_model: parseModelColumns(raw.chain_coding_model)
	};
}

/** The spec path a run will use. */
export function resolveSpecPath(cfg: AssetGenerationConfig): string {
	return cfg.spec_path ?? DEFAULT_SPEC_PATH;
}
