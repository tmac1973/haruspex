/** Guided-planning `type_config` JSON shape. */

export interface GuidedPlanningConfig {
	/** The seed idea the interview starts from. */
	initial_description: string | null;
	/** Plan output folder relative to working_dir. null = derive plan/<slug>/. */
	plan_output_dir: string | null;
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
				: null
	};
}
