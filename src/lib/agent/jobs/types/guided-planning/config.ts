/** Guided-planning `type_config` JSON shape. */

/**
 * How much of a run the user intends to sit through.
 *
 * `attended` is every run authored before this existed and stays the default.
 * `unattended_plan` skips the FINAL approval checkpoint only — the overview and
 * outline checkpoints land inside the window where the user is already
 * answering interview questions, and are the cheapest place to catch a bad
 * overview before it becomes an hour of planning.
 *
 * Phase 05 widens this with `unattended_chain`.
 */
import { parseChainModel, type ChainModel } from '../../chainModel';

/**
 * The model each chained stage runs on. Null means "same as this job", the
 * default; a value pins that stage to its own server and model.
 */
export interface GuidedPlanningChainModels {
	assets: ChainModel | null;
	coding: ChainModel | null;
}

/** Overrides applied to the coding job a chained run creates. */
export interface GuidedPlanningCodingRun {
	max_attempts: number | null;
	context_mode: 'step' | 'phase' | null;
	max_turns: number | null;
}

export type GuidedPlanningRunMode = 'attended' | 'unattended_plan' | 'unattended_chain';

/**
 * How hard the plan is checked before approval.
 *
 * - `full`: verify and revise until clean, up to MAX_VERIFY_ROUNDS rounds.
 * - `lite`: one verify, one revise if it found problems, no second verify.
 *   Everything that verify found goes to the handoff as open findings, since
 *   nothing confirms the revise fixed it.
 * - `skip`: no verification.
 */
export type GuidedPlanningVerification = 'full' | 'lite' | 'skip';

export const VERIFICATION_MODES: readonly GuidedPlanningVerification[] = ['full', 'lite', 'skip'];

const RUN_MODES: readonly GuidedPlanningRunMode[] = [
	'attended',
	'unattended_plan',
	'unattended_chain'
];

/** What the run view and the Editor call each mode. */
export const RUN_MODE_LABELS: Record<GuidedPlanningRunMode, string> = {
	attended: 'Attended',
	unattended_plan: 'Unattended plan',
	unattended_chain: 'Unattended plan + code'
};

export interface GuidedPlanningConfig {
	/** The seed idea the interview starts from. */
	initial_description: string | null;
	/** Plan output folder relative to working_dir. null = derive plan/<slug>/. */
	plan_output_dir: string | null;
	/**
	 * The independent verification stage: a fresh-context read of every phase
	 * file plus revise rounds, which on a local model is the longest stage of
	 * the run. `lite` or `skip` when the plan is small or you will read it
	 * yourself. Defaults to `full`. See `GuidedPlanningVerification`.
	 */
	verification: GuidedPlanningVerification;
	/**
	 * Offer web_search and research_url to the interview and write turns (never
	 * the verifier), so the plan is not bounded by the model's training cutoff.
	 * Defaults to on.
	 */
	web_research: boolean;
	/**
	 * Whether the plan may assume git. Off drops the "## Commit" section from
	 * every phase file, so a plan for an unversioned project never instructs a
	 * coding run to do something it will not do. "## Rollback" stays in both
	 * modes: rollback without git is still real ("delete the files this phase
	 * created"), and it is the last section of the template and therefore the
	 * tail-truncation detector in REQUIRED_PHASE_SECTIONS. Defaults to on.
	 */
	use_git: boolean;
	/**
	 * Write an asset spec from the finished plan and chain an asset run ahead
	 * of the coding run, so the code is built against art that already exists.
	 *
	 * Only does anything in `unattended_chain`: in every other mode nothing is
	 * chained, and a stage that wrote a spec no run would ever read would be
	 * work nobody asked for. Defaults to off — an image backend is a thing the
	 * user has to have configured, and a plan run must not start failing
	 * because a default turned on.
	 *
	 * There is deliberately no `asset_run` override block here. The handoff
	 * passes the three fields it actually sets, and an override object nothing
	 * reads would be an unchecked claim.
	 */
	generate_assets: boolean;
	/**
	 * Which checkpoints the run stops at. See `GuidedPlanningRunMode`.
	 * Anything unrecognised reads as `attended`: a malformed config must not
	 * silently make a run unattended.
	 */
	run_mode: GuidedPlanningRunMode;
	/**
	 * Settings for the coding run `unattended_chain` starts. Every field is
	 * nullable and null means "unset", so the coding job's own defaults and its
	 * preflight apply exactly as they would for a hand-created job.
	 *
	 * This exists because the handoff creates the job and starts it in the same
	 * breath: there is no window between the two in which to edit it, so
	 * whatever it is born with is what runs all night.
	 */
	coding_run: GuidedPlanningCodingRun;
	/** Only read in `unattended_chain`; ignored otherwise. */
	chain_models: GuidedPlanningChainModels;
	/**
	 * The planning skill for this kind of project, by name: its questions go
	 * into the overview interview, and its plan requirements into the outline
	 * and the verifier. Null for none, the default.
	 */
	planning_skill: string | null;
}

export function parseGuidedPlanningConfig(json: string | null): GuidedPlanningConfig {
	let raw: Record<string, unknown> = {};
	if (json) {
		try {
			const parsed: unknown = JSON.parse(json);
			if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
		} catch {
			// Malformed config behaves like no config.
		}
	}
	const mode: GuidedPlanningRunMode = RUN_MODES.includes(raw.run_mode as GuidedPlanningRunMode)
		? (raw.run_mode as GuidedPlanningRunMode)
		: 'attended';
	// `skip_verification: true` is how a skip was stored before the setting
	// had three values; anything else unrecognised is a full check.
	const verification: GuidedPlanningVerification = VERIFICATION_MODES.includes(
		raw.verification as GuidedPlanningVerification
	)
		? (raw.verification as GuidedPlanningVerification)
		: raw.skip_verification === true
			? 'skip'
			: 'full';
	// A malformed nested object behaves like no nested object, the same way a
	// malformed config behaves like no config above.
	const cr =
		raw.coding_run && typeof raw.coding_run === 'object' && !Array.isArray(raw.coding_run)
			? (raw.coding_run as Record<string, unknown>)
			: {};
	const codingRun: GuidedPlanningCodingRun = {
		max_attempts:
			typeof cr.max_attempts === 'number' && Number.isFinite(cr.max_attempts)
				? cr.max_attempts
				: null,
		context_mode:
			cr.context_mode === 'step' || cr.context_mode === 'phase' ? cr.context_mode : null,
		// Not clamped here: the coding job's own parser clamps, and this is the
		// same value flowing to the same place.
		max_turns:
			typeof cr.max_turns === 'number' && Number.isFinite(cr.max_turns) ? cr.max_turns : null
	};
	const cm =
		raw.chain_models && typeof raw.chain_models === 'object' && !Array.isArray(raw.chain_models)
			? (raw.chain_models as Record<string, unknown>)
			: {};
	return {
		initial_description:
			typeof raw.initial_description === 'string' && raw.initial_description.length > 0
				? raw.initial_description
				: null,
		plan_output_dir:
			typeof raw.plan_output_dir === 'string' && raw.plan_output_dir.length > 0
				? raw.plan_output_dir
				: null,
		// Absent means on, for older jobs too; only an explicit false opts out.
		web_research: raw.web_research !== false,
		use_git: raw.use_git !== false,
		// Absent means off, unlike the two above: this one costs GPU time and
		// needs a configured backend, so it is opt-in.
		generate_assets: raw.generate_assets === true,
		run_mode: mode,
		// Never skipped in unattended_chain, enforced HERE and not only in the
		// Editor: the severity gate is the one thing standing between a bad plan
		// and hours of unwatched code, and a hand-edited type_config must not
		// remove it. A skip there becomes lite, not full — one independent read
		// is what the gate needs, and the user asked for less, not more.
		verification: mode === 'unattended_chain' && verification === 'skip' ? 'lite' : verification,
		coding_run: codingRun,
		chain_models: {
			assets: parseChainModel(cm.assets),
			coding: parseChainModel(cm.coding)
		},
		planning_skill:
			typeof raw.planning_skill === 'string' && raw.planning_skill.trim()
				? raw.planning_skill.trim()
				: null
	};
}
