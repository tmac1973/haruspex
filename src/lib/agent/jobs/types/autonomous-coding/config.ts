/** Autonomous-coding `type_config` JSON shape. */

export interface AutonomousCodingConfig {
	/** Folder of .md plan files, relative to working_dir. Required to run. */
	plan_dir: string | null;
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
	/**
	 * Use git at all. Off means no branch, no commits and no signing fallback —
	 * for a machine without git installed, or a project the user does not want
	 * versioned. null = default (true), so every job authored before this
	 * existed keeps committing.
	 */
	use_git: boolean | null;
	/**
	 * Problems a guided-planning verifier reported and the planning run did not
	 * fix, carried over so preflight settles them before any code is written.
	 *
	 * Empty for a hand-created job, and for a chained one whose last review
	 * came back clean. Not a gate: a review cannot certify a plan clean, so
	 * these are the defects that happened to be caught, not all of them.
	 */
	open_findings: string[];
	/**
	 * Offer web_search and research_url to the preflight interview, so it can
	 * check versions and APIs past the model's training cutoff. The coding loop
	 * has them regardless. null = default (true).
	 */
	web_research: boolean | null;
	/**
	 * Settle every open decision in preflight without asking, exactly as a
	 * chained run does.
	 *
	 * A manually started run interviews the user, which is right the first time
	 * a plan is used and wrong every time after: re-running a coding job
	 * against a plan that already carries a DECISIONS file means sitting
	 * through an interview to re-answer settled questions, and a run started
	 * before bed parks on the question modal all night if it asks even one.
	 * With this on the run is unattended from its first second, exactly like a
	 * chained one. null = default (false), so nothing that used to interview
	 * silently stops.
	 */
	mute_preflight: boolean | null;
	/**
	 * Agent-loop turns one coding turn may spend before its result call is
	 * FORCED. Settings → Shell's "Max steps per task" governs the chat shell
	 * only and never reaches a job, so without this a job's budget is not
	 * adjustable at all. null = default (200); clamped to 50–600.
	 */
	max_turns: number | null;
}

/** Default agent-loop turns per coding turn. */
export const DEFAULT_MAX_TURNS = 200;
export const MIN_MAX_TURNS = 50;
export const MAX_MAX_TURNS = 600;

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
		max_attempts:
			typeof raw.max_attempts === 'number' && Number.isFinite(raw.max_attempts)
				? raw.max_attempts
				: null,
		context_mode: parseContextMode(raw.context_mode),
		signing_fallback:
			raw.signing_fallback === 'skip' || raw.signing_fallback === 'unsigned'
				? raw.signing_fallback
				: null,
		create_branch: parseOptionalBool(raw.create_branch),
		web_research: parseOptionalBool(raw.web_research),
		mute_preflight: parseOptionalBool(raw.mute_preflight),
		max_turns:
			typeof raw.max_turns === 'number' && Number.isFinite(raw.max_turns)
				? Math.min(MAX_MAX_TURNS, Math.max(MIN_MAX_TURNS, Math.round(raw.max_turns)))
				: null,
		use_git: parseOptionalBool(raw.use_git),
		open_findings: Array.isArray(raw.open_findings)
			? raw.open_findings.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
			: []
	};
}

function parseContextMode(v: unknown): 'step' | 'phase' | null {
	return v === 'phase' || v === 'step' ? v : null;
}

function parseOptionalBool(v: unknown): boolean | null {
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
