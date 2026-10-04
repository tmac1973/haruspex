/**
 * The jobs tables, in memory, for the UI end-to-end tests: just enough of
 * `src-tauri/src/db/jobs.rs` and `runs.rs` for a job to be created, listed,
 * run and read back. One page load, one database.
 */
import type {
	JobInput,
	JobStep,
	JobStepInput,
	JobSummary,
	JobWithSteps
} from '$lib/stores/jobs.svelte';
import type { JobRunStep, JobRunSummary } from '$lib/stores/jobRuns.svelte';

type Args = Record<string, unknown> | undefined;

interface Run extends JobRunSummary {
	steps: JobRunStep[];
}

const jobs = new Map<number, JobWithSteps>();
const runs = new Map<number, Run>();
let nextId = 1;

function summary(j: JobWithSteps): JobSummary {
	return {
		id: j.id,
		name: j.name,
		description: j.description,
		working_dir: j.working_dir,
		auto_approve_tools: j.auto_approve_tools,
		job_type: j.job_type,
		schedule_kind: j.schedule_kind,
		schedule_config: j.schedule_config,
		next_due_at: j.next_due_at,
		created_at: j.created_at,
		updated_at: j.updated_at,
		step_count: j.steps.length
	};
}

function runSummary(r: Run): JobRunSummary {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { steps, ...rest } = r;
	return rest;
}

function step(runId: number, ordering: number): JobRunStep | undefined {
	return runs.get(runId)?.steps.find((s) => s.ordering === ordering);
}

export const JOBS_DB: Record<string, (a: Args) => unknown> = {
	db_list_jobs: () => [...jobs.values()].map(summary),
	db_get_job: (a) => jobs.get(a?.id as number) ?? null,
	db_create_job: (a) => {
		const id = nextId++;
		const now = Date.now();
		jobs.set(id, { ...(a?.input as JobInput), id, created_at: now, updated_at: now, steps: [] });
		return id;
	},
	db_update_job: (a) => {
		const j = jobs.get(a?.id as number);
		if (j) jobs.set(j.id, { ...j, ...(a?.input as JobInput), updated_at: Date.now() });
		return null;
	},
	db_delete_job: (a) => {
		jobs.delete(a?.id as number);
		return null;
	},
	db_replace_job_steps: (a) => {
		const j = jobs.get(a?.jobId as number);
		if (j) {
			j.steps = (a?.steps as JobStepInput[]).map(
				(s, ordering): JobStep => ({ id: nextId++, ordering, ...s })
			);
		}
		return null;
	},
	db_list_due_jobs: () => [],
	db_set_job_next_due_at: () => null,

	db_list_job_runs: (a) =>
		[...runs.values()]
			.filter((r) => r.job_id === a?.jobId)
			.map(runSummary)
			.reverse(),
	db_get_job_run: (a) => runs.get(a?.runId as number) ?? null,
	db_create_job_run: (a) => {
		const id = nextId++;
		const prompts = (a?.stepPrompts as string[]) ?? [];
		runs.set(id, {
			id,
			job_id: a?.jobId as number,
			status: 'queued',
			trigger: a?.trigger as JobRunSummary['trigger'],
			queued_at: Date.now(),
			started_at: null,
			finished_at: null,
			error: null,
			planning_state: null,
			model_id: null,
			model_thinking: null,
			model_effort: null,
			context_size: null,
			steps: prompts.map((prompt_authored, ordering) => ({
				id: nextId++,
				run_id: id,
				ordering,
				prompt_authored,
				prompt_rendered: prompt_authored,
				status: 'pending',
				output: null,
				started_at: null,
				finished_at: null,
				error: null,
				stats: null
			}))
		});
		return id;
	},
	db_delete_job_run: (a) => {
		runs.delete(a?.runId as number);
		return null;
	},
	db_delete_all_job_runs: (a) => {
		for (const r of runs.values()) if (r.job_id === a?.jobId) runs.delete(r.id);
		return null;
	},
	db_mark_run_started: (a) => {
		const r = runs.get(a?.runId as number);
		if (r) Object.assign(r, { status: 'running', started_at: a?.startedAt });
		return null;
	},
	db_set_run_environment: () => null,
	db_mark_run_finished: (a) => {
		const r = runs.get(a?.runId as number);
		if (r)
			Object.assign(r, { status: a?.status, finished_at: a?.finishedAt, error: a?.error ?? null });
		return null;
	},
	db_mark_run_step_started: (a) => {
		const s = step(a?.runId as number, a?.ordering as number);
		if (s) {
			Object.assign(s, {
				status: 'running',
				started_at: a?.startedAt,
				prompt_rendered: a?.promptRendered
			});
		}
		return null;
	},
	db_mark_run_step_finished: (a) => {
		const s = step(a?.runId as number, a?.ordering as number);
		if (s) {
			Object.assign(s, {
				status: a?.status,
				output: a?.output ?? null,
				error: a?.error ?? null,
				finished_at: a?.finishedAt,
				stats: a?.stats ?? null
			});
		}
		return null;
	}
};
