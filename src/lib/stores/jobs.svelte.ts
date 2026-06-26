import { dbMutate, dbQuery } from './dbCall';

export type ScheduleKind = 'manual' | 'hourly' | 'daily' | 'weekly' | 'interval';

/**
 * `research` = the original sequential multi-step pipeline. `audit` = run one
 * prompt N independent times, then cluster + source-verify the findings into a
 * single meta-report.
 */
export type JobType = 'research' | 'audit';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type Schedule =
	| { kind: 'manual' }
	| { kind: 'hourly' }
	| { kind: 'daily'; time: string }
	| { kind: 'weekly'; day: Weekday; time: string }
	| { kind: 'interval'; minutes: number };

export interface JobStep {
	id: number;
	ordering: number;
	prompt: string;
	deep_research: boolean;
}

export interface JobStepInput {
	prompt: string;
	deep_research: boolean;
}

export interface JobSummary {
	id: number;
	name: string;
	description: string | null;
	working_dir: string;
	auto_approve_tools: boolean;
	job_type: JobType;
	schedule_kind: ScheduleKind;
	schedule_config: string | null;
	next_due_at: number | null;
	created_at: number;
	updated_at: number;
	step_count: number;
}

/** Audit-job config (ignored when job_type !== 'audit'). */
export interface AuditConfig {
	/** Number of independent sample runs to execute. */
	audit_num_runs: number | null;
	/** File the meta-report is written to (relative to working_dir). */
	audit_output_file: string | null;
	/** Run sample + verification turns with a read-only tool subset. */
	audit_read_only: boolean;
	/**
	 * Per-sample agent-loop turn budget (read/grep iterations). null = runner
	 * default. Bigger codebases need more turns to grep thoroughly.
	 */
	audit_max_iterations: number | null;
	/** Custom sample-run instructions (appended to the audit prompt). null = default. */
	audit_sample_instructions: string | null;
	/** Custom verification rubric. null = default. */
	audit_verify_instructions: string | null;
}

/**
 * Per-job remote model override (applies to every job type, not just audits).
 * When `model_remote_base_url` is set the job runs all its model calls against
 * this remote server/model instead of the global Settings backend. Remote-only:
 * leaving these null means "use whatever Settings has selected" (local or remote).
 */
export interface ModelOverrideConfig {
	/** Remote base URL (no trailing slash, no /v1). null/blank = use Settings. */
	model_remote_base_url: string | null;
	/** Optional Bearer token for the override server. */
	model_remote_api_key: string | null;
	/** Model ID sent to the override server. */
	model_remote_model_id: string | null;
	/**
	 * Context window (tokens/request) of the override model, used for budget +
	 * compaction math. null = fall back to the global active context size.
	 * Remote models often have a much larger window than the local default, so
	 * leaving this unset would needlessly cap how much the job can hold.
	 */
	model_remote_context_size: number | null;
	/**
	 * Whether the override model accepts image input. null = inherit the global
	 * Settings vision capability; false hides vision tools for this job's turns.
	 */
	model_remote_vision_supported: boolean | null;
}

export interface JobWithSteps extends AuditConfig, ModelOverrideConfig {
	id: number;
	name: string;
	description: string | null;
	working_dir: string;
	auto_approve_tools: boolean;
	job_type: JobType;
	schedule_kind: ScheduleKind;
	schedule_config: string | null;
	next_due_at: number | null;
	created_at: number;
	updated_at: number;
	steps: JobStep[];
}

export interface JobInput extends AuditConfig, ModelOverrideConfig {
	name: string;
	description: string | null;
	working_dir: string;
	auto_approve_tools: boolean;
	job_type: JobType;
	schedule_kind: ScheduleKind;
	schedule_config: string | null;
	next_due_at: number | null;
}

const WEEKDAY_INDEX: Record<Weekday, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6
};

// Pure date math — Date instances here are computational, not reactive
// state. The svelte plugin's prefer-svelte-reactivity rule defaults to
// flagging mutable Date in .svelte.ts files; disable it for these
// helpers since moving them out of this file would split jobs-related
// logic across modules unnecessarily.

/* eslint-disable svelte/prefer-svelte-reactivity */

function nextDailyDue(time: string, now: Date): number {
	const [h, m] = time.split(':').map((n) => parseInt(n, 10));
	const target = new Date(now);
	target.setHours(h, m, 0, 0);
	if (target.getTime() <= now.getTime()) {
		target.setDate(target.getDate() + 1);
	}
	return target.getTime();
}

function nextWeeklyDue(day: Weekday, time: string, now: Date): number {
	const [h, m] = time.split(':').map((n) => parseInt(n, 10));
	const targetDow = WEEKDAY_INDEX[day];
	const target = new Date(now);
	target.setHours(h, m, 0, 0);
	const daysAhead = (targetDow - target.getDay() + 7) % 7;
	if (daysAhead === 0 && target.getTime() <= now.getTime()) {
		target.setDate(target.getDate() + 7);
	} else if (daysAhead > 0) {
		target.setDate(target.getDate() + daysAhead);
	}
	return target.getTime();
}

/**
 * Compute the next unix-ms when a job is due to fire.
 *
 * `prevDue` is the previous next_due_at value, used only by the
 * `interval` schedule so cadence stays steady even if a run took
 * longer than the interval (next due = previous due + minutes,
 * not now + minutes). For the very first scheduling pass `prevDue`
 * should be null so we anchor on `now`.
 *
 * Returns null for `manual` (the scheduler never fires manual jobs).
 */
export function computeNextDueAt(
	schedule: Schedule,
	prevDue: number | null,
	now: Date = new Date()
): number | null {
	switch (schedule.kind) {
		case 'manual':
			return null;
		case 'hourly': {
			// Next top-of-hour, in UTC ms (hours align across timezones).
			const ms = now.getTime();
			return Math.floor(ms / 3_600_000) * 3_600_000 + 3_600_000;
		}
		case 'daily':
			return nextDailyDue(schedule.time, now);
		case 'weekly':
			return nextWeeklyDue(schedule.day, schedule.time, now);
		case 'interval': {
			const ms = schedule.minutes * 60_000;
			if (prevDue !== null && prevDue > 0) {
				// Anchor on the previous due time; if we've drifted multiple
				// intervals behind (e.g. app was closed), skip ahead so we
				// don't fire a burst of catch-up runs.
				let next = prevDue + ms;
				const nowMs = now.getTime();
				if (next <= nowMs) {
					const missed = Math.floor((nowMs - next) / ms) + 1;
					next += missed * ms;
				}
				return next;
			}
			return now.getTime() + ms;
		}
	}
}

/* eslint-enable svelte/prefer-svelte-reactivity */

export function scheduleToConfigJson(schedule: Schedule): string | null {
	switch (schedule.kind) {
		case 'manual':
		case 'hourly':
			return null;
		case 'daily':
			return JSON.stringify({ time: schedule.time });
		case 'weekly':
			return JSON.stringify({ day: schedule.day, time: schedule.time });
		case 'interval':
			return JSON.stringify({ minutes: schedule.minutes });
	}
}

export function configJsonToSchedule(
	kind: ScheduleKind,
	configJson: string | null
): Schedule | null {
	if (kind === 'manual') return { kind: 'manual' };
	if (kind === 'hourly') return { kind: 'hourly' };
	if (!configJson) return null;
	try {
		const parsed = JSON.parse(configJson);
		if (kind === 'daily' && typeof parsed.time === 'string') {
			return { kind: 'daily', time: parsed.time };
		}
		if (kind === 'weekly' && typeof parsed.day === 'string' && typeof parsed.time === 'string') {
			return { kind: 'weekly', day: parsed.day as Weekday, time: parsed.time };
		}
		if (kind === 'interval' && typeof parsed.minutes === 'number') {
			return { kind: 'interval', minutes: parsed.minutes };
		}
	} catch {
		// fall through
	}
	return null;
}

let jobs = $state<JobSummary[]>([]);
let loaded = $state(false);

export function getJobs(): JobSummary[] {
	return jobs;
}

export function isJobsLoaded(): boolean {
	return loaded;
}

export async function loadJobs(): Promise<void> {
	jobs = await dbQuery<JobSummary[]>({
		cmd: 'db_list_jobs',
		fallback: [],
		onError: 'loadJobs failed'
	});
	loaded = true;
}

export function createJob(input: JobInput): Promise<number | null> {
	return dbQuery<number | null>({
		cmd: 'db_create_job',
		args: { input },
		fallback: null,
		onError: 'createJob failed',
		onSuccess: loadJobs
	});
}

export function updateJob(id: number, input: JobInput): Promise<boolean> {
	return dbMutate({
		cmd: 'db_update_job',
		args: { id, input },
		onError: 'updateJob failed',
		ctx: { id },
		onSuccess: loadJobs
	});
}

export function deleteJob(id: number): Promise<boolean> {
	return dbMutate({
		cmd: 'db_delete_job',
		args: { id },
		onError: 'deleteJob failed',
		ctx: { id },
		onSuccess: loadJobs
	});
}

export function getJob(id: number): Promise<JobWithSteps | null> {
	return dbQuery<JobWithSteps | null>({
		cmd: 'db_get_job',
		args: { id },
		fallback: null,
		onError: 'getJob failed',
		ctx: { id }
	});
}

export function listDueJobs(nowMs: number): Promise<JobSummary[]> {
	return dbQuery<JobSummary[]>({
		cmd: 'db_list_due_jobs',
		args: { nowMs },
		fallback: [],
		onError: 'listDueJobs failed'
	});
}

export async function setJobNextDueAt(jobId: number, nextDueAt: number | null): Promise<void> {
	await dbMutate({
		cmd: 'db_set_job_next_due_at',
		args: { jobId, nextDueAt },
		onError: 'setJobNextDueAt failed',
		ctx: { jobId }
	});
}

export function replaceJobSteps(jobId: number, steps: JobStepInput[]): Promise<boolean> {
	return dbMutate({
		cmd: 'db_replace_job_steps',
		args: { jobId, steps },
		onError: 'replaceJobSteps failed',
		ctx: { jobId },
		// The list summary includes step_count — without this refresh the
		// just-created job stays at step_count=0 in the list until something
		// else triggers loadJobs, which disables its Run button.
		onSuccess: loadJobs
	});
}
