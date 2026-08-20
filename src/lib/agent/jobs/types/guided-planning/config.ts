/** Guided-planning `type_config` JSON shape. */

export interface GuidedPlanningConfig {
	/** The seed idea the interview starts from. */
	initial_description: string | null;
	/** Plan output folder relative to working_dir. null = derive plan/<slug>/. */
	plan_output_dir: string | null;
	/**
	 * Skip the independent verification stage. It is a fresh-context read of
	 * every phase file plus up to three revise rounds, which on a local model
	 * is the longest stage of the run — worth skipping when the plan is small
	 * or you intend to read it yourself. Defaults to running it.
	 */
	skip_verification: boolean;
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
	return {
		initial_description:
			typeof raw.initial_description === 'string' && raw.initial_description.length > 0
				? raw.initial_description
				: null,
		plan_output_dir:
			typeof raw.plan_output_dir === 'string' && raw.plan_output_dir.length > 0
				? raw.plan_output_dir
				: null,
		// Absent (every job authored before this existed) means verify.
		skip_verification: raw.skip_verification === true
	};
}
