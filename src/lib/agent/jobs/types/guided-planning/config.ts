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
/** Overrides applied to the coding job a chained run creates. */
export interface GuidedPlanningCodingRun {
	max_attempts: number | null;
	context_mode: 'step' | 'phase' | null;
	max_turns: number | null;
}

export type GuidedPlanningRunMode = 'attended' | 'unattended_plan' | 'unattended_chain';

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
	 * Skip the independent verification stage. It is a fresh-context read of
	 * every phase file plus several revise rounds, which on a local model
	 * is the longest stage of the run — worth skipping when the plan is small
	 * or you intend to read it yourself. Defaults to running it.
	 */
	skip_verification: boolean;
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
	const skipVerification = raw.skip_verification === true;
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
		run_mode: mode,
		// Absent (every job authored before this existed) means verify. Forced
		// off for unattended_chain HERE, not only in the Editor: the severity
		// gate is the one thing standing between a bad plan and hours of
		// unwatched code, and a hand-edited type_config must not remove it.
		skip_verification: mode === 'unattended_chain' ? false : skipVerification,
		coding_run: codingRun
	};
}
