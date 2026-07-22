/** Autonomous-coding `type_config` JSON shape. */

export interface AutonomousCodingConfig {
	/** Folder of .md plan files, relative to working_dir. Required to run. */
	plan_dir: string | null;
	/**
	 * Deep verification command (e.g. `npm test`), run by the RUNNER when each
	 * phase's last item lands — not per item, and not by the model. null = the
	 * preflight settles it (recorded in DECISIONS-coding.md).
	 */
	verify_command: string | null;
	/**
	 * Cheap static check (e.g. `npm run lint`, `tsc --noEmit`), run by the
	 * RUNNER before every step commit so a broken file never lands. null = the
	 * preflight settles it.
	 */
	step_check_command: string | null;
	/** Failed attempts per item before it's marked BLOCKED. null = default (3). */
	max_attempts: number | null;
	/**
	 * Loop context strategy: 'phase' (default) = one continuous context builds
	 * each plan phase, which the runner then verifies and commits as a unit;
	 * 'step' = a fresh context per checklist item with per-item checks and
	 * commits. null = default.
	 */
	context_mode: 'step' | 'phase' | null;
	/**
	 * What the runner does when commit signing fails mid-run (expired
	 * 1Password/gpg-agent authorization): 'unsigned' commits with signing
	 * disabled (re-sign before pushing); 'skip' never commits unsigned — the
	 * work stays uncommitted in the working tree (for repos that reject
	 * unsigned commits). null = default ('unsigned').
	 */
	signing_fallback: 'unsigned' | 'skip' | null;
}

export function parseAutonomousCodingConfig(json: string | null): AutonomousCodingConfig {
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
		plan_dir: typeof raw.plan_dir === 'string' && raw.plan_dir.length > 0 ? raw.plan_dir : null,
		verify_command:
			typeof raw.verify_command === 'string' && raw.verify_command.length > 0
				? raw.verify_command
				: null,
		step_check_command:
			typeof raw.step_check_command === 'string' && raw.step_check_command.length > 0
				? raw.step_check_command
				: null,
		max_attempts:
			typeof raw.max_attempts === 'number' && Number.isFinite(raw.max_attempts)
				? raw.max_attempts
				: null,
		context_mode: parseContextMode(raw.context_mode),
		signing_fallback:
			raw.signing_fallback === 'skip' || raw.signing_fallback === 'unsigned'
				? raw.signing_fallback
				: null
	};
}

function parseContextMode(v: unknown): 'step' | 'phase' | null {
	return v === 'phase' || v === 'step' ? v : null;
}

/** The plan dir with a guaranteed trailing slash (path-building convenience). */
export function normalizePlanDir(dir: string): string {
	const d = dir.trim();
	return d.endsWith('/') ? d : `${d}/`;
}
