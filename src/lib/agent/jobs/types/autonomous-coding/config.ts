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
	/**
	 * When true, create a new branch before starting the coding run. The branch
	 * is named `haruspex/autonomous-coding/<epoch_ms>` and all run commits land
	 * on it instead of the user's current branch. (A brand-new repo with no
	 * commits stays on its default branch — its entire history IS the run.)
	 * null = default (true).
	 */
	create_branch: boolean | null;
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
				: null,
		create_branch: parseCreateBranch(raw.create_branch)
	};
}

function parseContextMode(v: unknown): 'step' | 'phase' | null {
	return v === 'phase' || v === 'step' ? v : null;
}

function parseCreateBranch(v: unknown): boolean | null {
	return typeof v === 'boolean' ? v : null;
}

/** The plan dir with a guaranteed trailing slash (path-building convenience). */
export function normalizePlanDir(dir: string): string {
	const d = dir.trim();
	return d.endsWith('/') ? d : `${d}/`;
}

/**
 * Convert a directory chosen from the system file dialog into a path relative
 * to the job's working dir, or explain why it can't be used.
 *
 * `plan_dir` is resolved relative to the working dir everywhere downstream —
 * `tryParsePlanDir` passes it to `fs_list_dir` as `relPath` — so an absolute
 * path, or one outside the tree, would fail at run time during preflight,
 * hours after the mistake. Failing here means it is fixable while the editor
 * is still open.
 *
 * Separators are normalized to '/', which is what the fs_* IPC layer expects
 * on every platform.
 */
export function planDirFromPicked(
	workingDir: string,
	picked: string
): { ok: true; relative: string } | { ok: false; error: string } {
	const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
	const root = norm(workingDir);
	const target = norm(picked);
	if (!root) {
		return { ok: false, error: 'Set the job’s working directory first.' };
	}
	if (target === root) {
		// The working dir itself is legal — a repo whose plans sit at its root.
		return { ok: true, relative: '' };
	}
	// The trailing slash is the boundary check: without it "/repo-old" would
	// count as inside "/repo".
	if (!target.startsWith(`${root}/`)) {
		return {
			ok: false,
			error: 'Pick a folder inside the working directory — plan paths are relative to it.'
		};
	}
	return { ok: true, relative: normalizePlanDir(target.slice(root.length + 1)) };
}
