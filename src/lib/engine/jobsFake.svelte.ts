/**
 * A runner, jobs store and run store for `jobs.test.ts`: enough state, held
 * in runes so the watcher's effects see it change, to drive the job ops.
 */
import { vi } from 'vitest';
import type { PendingQueueEntry, RunState } from '#lib/agent/jobs/runner.svelte.ts';
import type { JobInput, JobStepInput, JobWithSteps } from '#lib/stores/jobs.svelte.ts';

export const fake = $state({
	current: null as RunState | null,
	queue: [] as PendingQueueEntry[],
	jobs: [] as JobWithSteps[],
	cancelled: [] as number[],
	finished: [] as { runId: number; status: string }[],
	deletedRuns: [] as number[],
	runs: {} as Record<number, { id: number; job_id: number; status: string; steps: unknown[] }>
});

let nextId = 1;

export function reset(): void {
	fake.current = null;
	fake.queue = [];
	fake.jobs = [];
	fake.cancelled = [];
	fake.finished = [];
	fake.deletedRuns = [];
	fake.runs = {};
	nextId = 1;
}

export function job(id: number, patch: Partial<JobWithSteps> = {}): JobWithSteps {
	const j: JobWithSteps = {
		id,
		name: `Job ${id}`,
		description: null,
		working_dir: '/home/me/proj',
		auto_approve_tools: true,
		job_type: 'research',
		schedule_kind: 'manual',
		schedule_config: null,
		next_due_at: null,
		type_config: null,
		model_remote_base_url: null,
		model_remote_api_key: null,
		model_remote_api_key_id: null,
		model_remote_model_id: null,
		model_remote_context_size: null,
		model_remote_vision_supported: null,
		model_advanced: null,
		created_at: 0,
		updated_at: 0,
		steps: [{ id: 1, ordering: 0, prompt: 'Find it', deep_research: false }],
		...patch
	};
	fake.jobs.push(j);
	nextId = Math.max(nextId, id + 1);
	return j;
}

export function running(runId: number, jobId: number, patch: Partial<RunState> = {}): RunState {
	fake.current = {
		id: runId,
		jobId,
		jobName: `Job ${jobId}`,
		jobType: 'research',
		contextSize: 32768,
		environment: {} as RunState['environment'],
		steps: [
			{
				index: 0,
				promptAuthored: 'Find it',
				promptRendered: 'Find it',
				deepResearch: false,
				description: null,
				checklist: null,
				status: 'running',
				streaming: '',
				output: '',
				reasoning: 'thinking',
				usage: null,
				thinking: null,
				error: null,
				searchSteps: [],
				sizeWarning: null,
				startedAt: 1,
				finishedAt: null
			} as unknown as RunState['steps'][number]
		],
		currentStepIndex: 0,
		status: 'running',
		error: null,
		waitingForSlot: false,
		startedAt: 1,
		finishedAt: null,
		...patch
	};
	fake.runs[runId] = { id: runId, job_id: jobId, status: 'running', steps: [] };
	return fake.current;
}

const find = (id: number) => fake.jobs.find((j) => j.id === id) ?? null;

export const runner = {
	getCurrentRun: () => fake.current,
	getPendingQueue: () => fake.queue,
	getRunningRunId: () => (fake.current?.status === 'running' ? fake.current.id : null),
	cancel: (runId: number) => void fake.cancelled.push(runId),
	removeQueuedRun: (runId: number) => {
		const before = fake.queue.length;
		fake.queue = fake.queue.filter((q) => q.runId !== runId);
		return fake.queue.length < before;
	},
	removeQueuedRunsForJob: (jobId: number) => {
		const before = fake.queue.length;
		fake.queue = fake.queue.filter((q) => q.jobId !== jobId);
		return before - fake.queue.length;
	},
	enqueue: vi.fn(async (jobId: number, trigger: string) => {
		const runId = 100 + fake.queue.length + (fake.current ? 1 : 0);
		fake.runs[runId] = { id: runId, job_id: jobId, status: 'queued', steps: [] };
		if (fake.current?.status === 'running') {
			fake.queue = [
				...fake.queue,
				{ runId, jobId, jobName: `Job ${jobId}`, trigger: trigger as 'manual' }
			];
		} else {
			running(runId, jobId);
		}
		return runId;
	})
};

export const jobsStore = {
	getJob: async (id: number) => {
		const j = find(id);
		return j ? (JSON.parse(JSON.stringify(j)) as JobWithSteps) : null;
	},
	getJobs: () => fake.jobs.map((j) => ({ ...j, step_count: j.steps.length })),
	loadJobs: async () => {},
	createJob: vi.fn(async (input: JobInput) => {
		const id = nextId++;
		fake.jobs.push({ ...input, id, created_at: 0, updated_at: 0, steps: [] } as JobWithSteps);
		return id;
	}),
	updateJob: vi.fn(async (id: number, input: JobInput) => {
		const j = find(id);
		if (!j) return false;
		Object.assign(j, input);
		return true;
	}),
	deleteJob: vi.fn(async (id: number) => {
		fake.jobs = fake.jobs.filter((j) => j.id !== id);
		return true;
	}),
	duplicateJob: async (id: number) => {
		const j = find(id);
		if (!j) return null;
		return job(nextId, { ...j, id: nextId, name: `${j.name} (copy)` }).id;
	},
	replaceJobSteps: vi.fn(async (jobId: number, steps: JobStepInput[]) => {
		const j = find(jobId);
		if (!j) return false;
		j.steps = steps.map((s, i) => ({ id: i + 1, ordering: i, ...s }));
		return true;
	})
};

export const runsStore = {
	getJobRun: async (runId: number) => fake.runs[runId] ?? null,
	getRunsForJob: (jobId: number) => Object.values(fake.runs).filter((r) => r.job_id === jobId),
	loadRunsForJob: async () => {},
	deleteJobRun: async (_jobId: number, runId: number) => {
		fake.deletedRuns.push(runId);
		delete fake.runs[runId];
		return true;
	},
	markRunFinished: async (runId: number, _jobId: number, status: string) => {
		fake.finished.push({ runId, status });
	}
};
