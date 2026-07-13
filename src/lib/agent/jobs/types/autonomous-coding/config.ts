/** Autonomous-coding `type_config` JSON shape. */

export interface AutonomousCodingConfig {
	/** Folder of .md plan files, relative to working_dir. Required to run. */
	plan_dir: string | null;
	/**
	 * Command that proves a step works (e.g. `npm test`). null = the model
	 * verifies by its own judgment (build/run what it changed).
	 */
	verify_command: string | null;
	/** Failed attempts per item before it's marked BLOCKED. null = default (3). */
	max_attempts: number | null;
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
		max_attempts:
			typeof raw.max_attempts === 'number' && Number.isFinite(raw.max_attempts)
				? raw.max_attempts
				: null,
		signing_fallback:
			raw.signing_fallback === 'skip' || raw.signing_fallback === 'unsigned'
				? raw.signing_fallback
				: null
	};
}

/** The plan dir with a guaranteed trailing slash (path-building convenience). */
export function normalizePlanDir(dir: string): string {
	const d = dir.trim();
	return d.endsWith('/') ? d : `${d}/`;
}
