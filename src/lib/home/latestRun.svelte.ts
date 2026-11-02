/**
 * The latest run of a job, for a Home card. Reads the Jobs tab's reactive
 * run list (`getRunsForJob`), which the runner reloads when a run is created
 * and when it finishes, so a card follows runs with no events of its own.
 * Steps come from the database once per run and status.
 */
import {
	getJobRun,
	getRunsForJob,
	loadRunsForJob,
	type JobRunSummary,
	type JobRunWithSteps
} from '#lib/stores/jobRuns.svelte.ts';

export interface LatestRun {
	/** The newest run of any status, or null for a job that never ran. */
	latest: JobRunSummary | null;
	/** The newest succeeded run with its steps; null until they load, or when none succeeded. */
	latestSucceeded: JobRunWithSteps | null;
}

/** Jobs whose run list was asked for. Plain, not reactive: it is written while rendering. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const requested = new Set<number>();
/** `runId:status` keys with a fetch going or done. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const fetched = new Set<string>();
const withSteps = $state<Record<number, { status: string; run: JobRunWithSteps }>>({});

function stepsFor(summary: JobRunSummary): JobRunWithSteps | null {
	const key = `${summary.id}:${summary.status}`;
	if (!fetched.has(key)) {
		fetched.add(key);
		void getJobRun(summary.id).then((run) => {
			if (run) withSteps[summary.id] = { status: summary.status, run };
		});
	}
	const cached = withSteps[summary.id];
	return cached?.status === summary.status ? cached.run : null;
}

export function getLatestRun(jobId: number): LatestRun {
	if (!requested.has(jobId)) {
		requested.add(jobId);
		void loadRunsForJob(jobId);
	}
	// Newest first, as the database lists them.
	const runs = getRunsForJob(jobId);
	const succeeded = runs.find((r) => r.status === 'succeeded');
	return {
		latest: runs[0] ?? null,
		latestSucceeded: succeeded ? stepsFor(succeeded) : null
	};
}

/** The last step's output of a run: what a job produced. */
export function finalOutput(run: JobRunWithSteps): string | null {
	for (let i = run.steps.length - 1; i >= 0; i--) {
		const out = run.steps[i].output;
		if (out) return out;
	}
	return null;
}

export function _resetForTests(): void {
	requested.clear();
	fetched.clear();
	for (const id of Object.keys(withSteps)) delete withSteps[Number(id)];
}
