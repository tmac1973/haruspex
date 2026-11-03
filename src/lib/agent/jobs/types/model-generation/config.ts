/** 3D models job `type_config` JSON shape. */

import {
	parseChainModel,
	parseModelColumns,
	type ChainModel,
	type ModelColumns
} from '#lib/agent/jobs/chainModel.ts';
import { DEFAULT_MODELS_SPEC_PATH } from '#lib/models3d/spec/paths.ts';
import { clampInt } from '#lib/utils/clampInt.ts';

/** Whether the run stops after creation for a review. */
export type ModelRunMode = 'attended' | 'unattended';

const RUN_MODES: readonly ModelRunMode[] = ['attended', 'unattended'];

/** Model steps per creation or animation turn. */
export const DEFAULT_STAGE_TURNS = 40;
export const MIN_STAGE_TURNS = 10;
export const MAX_STAGE_TURNS = 120;

/** Turns per asset before it is marked "needs work". */
export const DEFAULT_ROUNDS = 3;
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 6;

export interface ModelGenerationConfig {
	/** The spec file, relative to working_dir. null = the default path. */
	spec_path: string | null;
	/** What to make, when there is no spec file yet. */
	description: string | null;
	/**
	 * `attended` stops after creation for a review. Anything unrecognised
	 * reads as `attended`: a malformed config must not silently make a run
	 * unattended, the rule the 2D job and guided planning follow.
	 */
	run_mode: ModelRunMode;
	/** The model that builds each model. Null = same as this job. */
	create_model: ChainModel | null;
	/** The model that writes the clips. Null = same as this job. */
	animate_model: ChainModel | null;
	/** Offer the creation model the code-drawn texture tool. Off by default. */
	allow_textures: boolean;
	/** maxIterations for one creation turn. */
	create_turns: number;
	/** maxIterations for one animation turn. */
	animate_turns: number;
	/** Turns per asset (and per clip set) before it is marked "needs work". */
	rounds: number;
	/** Use git at all. On by default, as the 2D job. */
	use_git: boolean;
	/**
	 * An autonomous-coding configuration to start after this job, carried the
	 * way the 2D job carries it. Null for a standalone run.
	 */
	coding_run: Record<string, unknown> | null;
	/**
	 * Whether a run started by hand still starts the coding run. A chained run
	 * always does. Null means yes, so a broken chain is resumed by re-running.
	 */
	hand_off: boolean | null;
	/** Set by a chain: the planning job's name, for the coding job's name. */
	chain_base_name: string | null;
	/** Set by a chain: the coding stage's model as the planning job resolved it. */
	chain_coding_model: ModelColumns | null;
}

/** A number rounded into `[lo, hi]`, or `fallback` for anything that isn't one. */
function intOr(v: unknown, lo: number, hi: number, fallback: number): number {
	return typeof v === 'number' && Number.isFinite(v) ? clampInt(v, lo, hi, Math.round) : fallback;
}

function text(v: unknown): string | null {
	return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export function parseModelGenerationConfig(json: string | null): ModelGenerationConfig {
	let raw: Record<string, unknown> = {};
	if (json) {
		try {
			const parsed: unknown = JSON.parse(json);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				raw = parsed as Record<string, unknown>;
			}
		} catch {
			// Malformed config behaves like no config.
		}
	}
	return {
		spec_path: text(raw.spec_path),
		// Kept as typed, not trimmed: line breaks in a description are content.
		description: text(raw.description) === null ? null : (raw.description as string),
		run_mode: RUN_MODES.includes(raw.run_mode as ModelRunMode)
			? (raw.run_mode as ModelRunMode)
			: 'attended',
		create_model: parseChainModel(raw.create_model),
		animate_model: parseChainModel(raw.animate_model),
		// Opt-in: only an explicit true turns it on.
		allow_textures: raw.allow_textures === true,
		create_turns: intOr(raw.create_turns, MIN_STAGE_TURNS, MAX_STAGE_TURNS, DEFAULT_STAGE_TURNS),
		animate_turns: intOr(raw.animate_turns, MIN_STAGE_TURNS, MAX_STAGE_TURNS, DEFAULT_STAGE_TURNS),
		rounds: intOr(raw.rounds, MIN_ROUNDS, MAX_ROUNDS, DEFAULT_ROUNDS),
		use_git: raw.use_git !== false,
		coding_run:
			raw.coding_run && typeof raw.coding_run === 'object' && !Array.isArray(raw.coding_run)
				? (raw.coding_run as Record<string, unknown>)
				: null,
		hand_off: typeof raw.hand_off === 'boolean' ? raw.hand_off : null,
		chain_base_name: text(raw.chain_base_name),
		chain_coding_model: parseModelColumns(raw.chain_coding_model)
	};
}

/** The spec path a run will use. */
export function resolveModelsSpecPath(cfg: ModelGenerationConfig): string {
	return cfg.spec_path ?? DEFAULT_MODELS_SPEC_PATH;
}
