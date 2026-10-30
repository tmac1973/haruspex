import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock(
	'#lib/agent/jobs/runner.svelte.ts',
	async () => (await import('./jobsFake.svelte.ts')).runner
);
vi.mock('#lib/stores/jobs.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/jobs.svelte.ts')>()),
	...(await import('./jobsFake.svelte.ts')).jobsStore
}));
vi.mock(
	'#lib/stores/jobRuns.svelte.ts',
	async () => (await import('./jobsFake.svelte.ts')).runsStore
);
vi.mock('#lib/agent/jobs/types/index.ts', () => {
	const research = {
		id: 'research',
		label: 'Research',
		description: 'Steps in order.',
		hasPlannedSteps: true,
		configDefaults: () => ({ depth: 1 }),
		configFromJob: (c: string | null) => (c ? JSON.parse(c) : { depth: 1 }),
		configToJson: (c: Record<string, unknown>) => JSON.stringify(c),
		validate: ({ steps }: { steps: unknown[] }) => (steps.length ? null : 'Add a step.')
	};
	const planning = {
		id: 'guided_planning',
		label: 'Guided planning',
		description: 'Asks, then plans.',
		hasPlannedSteps: false,
		supportsSchedule: false,
		configDefaults: () => ({ overview_only: false }),
		configFromJob: (c: string | null) => (c ? JSON.parse(c) : { overview_only: false }),
		configToJson: (c: Record<string, unknown>) => JSON.stringify(c)
	};
	const coding = {
		...research,
		id: 'autonomous_coding',
		label: 'Autonomous coding',
		available: async () => false
	};
	const all = [research, planning, coding];
	return {
		getJobType: (id: string) => all.find((t) => t.id === id),
		listJobTypes: () => all
	};
});

const lean = vi.hoisted(() => ({ on: false }));
vi.mock('#lib/agent/jobs/types/lean.ts', () => ({
	pausedByLean: (id: string) => lean.on && id !== 'research'
}));

import { flushSync } from 'svelte';
import { dispatchJobs, watchJobs } from './jobs.svelte.ts';
import { fake, job, reset, running, jobsStore } from './jobsFake.svelte.ts';
import { LIVE_MS } from './watch.svelte.ts';
import type { JobEvent, JobOp } from './types.ts';

/** An answer as plain JSON, read into freely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const run = (op: JobOp) => dispatchJobs(op) as Promise<Json>;

async function settle() {
	flushSync();
	await new Promise((r) => setTimeout(r, LIVE_MS * 2));
	flushSync();
}

beforeEach(() => {
	reset();
	vi.clearAllMocks();
	lean.on = false;
});

describe('reading jobs', () => {
	it('lists the job types with their defaults and whether they can run here', async () => {
		const types = await run({ type: 'jobs.types' });
		expect(types.map((t: Json) => [t.id, t.schedulable, t.available])).toEqual([
			['research', true, true],
			['guided_planning', false, true],
			['autonomous_coding', true, false]
		]);
		expect(types[0].configDefaults).toEqual({ depth: 1 });
	});

	it('lists research alone in lean mode', async () => {
		lean.on = true;
		const types = await run({ type: 'jobs.types' });
		expect(types.map((t: Json) => t.id)).toEqual(['research']);
	});

	it('reads a job with its config parsed and its inline key blanked', async () => {
		job(1, { type_config: '{"depth":3}', model_remote_api_key: 'sk-inline' });
		const got = await run({ type: 'jobs.get', jobId: 1 });
		expect(got).toMatchObject({
			id: 1,
			config: { depth: 3 },
			schedule: { kind: 'manual' },
			model_remote_api_key: null,
			has_inline_api_key: true
		});
	});

	it('says when there is no such job', async () => {
		await expect(run({ type: 'jobs.get', jobId: 9 })).rejects.toThrow('no job 9');
	});
});

describe('writing jobs', () => {
	it('creates a job with its steps, config over the defaults, and its tools auto-approved', async () => {
		const { jobId } = await run({
			type: 'jobs.create',
			job: { name: '  Prices ', job_type: 'research', working_dir: '/w' },
			steps: ['Find the prices', { prompt: 'Compare them', deep_research: true }, '  '],
			config: { extra: true }
		});
		const saved = fake.jobs.find((j) => j.id === jobId)!;
		expect(saved).toMatchObject({
			name: 'Prices',
			auto_approve_tools: true,
			type_config: '{"depth":1,"extra":true}',
			schedule_kind: 'manual'
		});
		expect(saved.steps.map((s) => [s.prompt, s.deep_research])).toEqual([
			['Find the prices', false],
			['Compare them', true]
		]);
	});

	it("refuses what the editor would: no name, the type's own check", async () => {
		await expect(
			run({ type: 'jobs.create', job: { name: ' ', job_type: 'research' }, steps: ['x'] })
		).rejects.toThrow('a job needs a name');
		await expect(
			run({ type: 'jobs.create', job: { name: 'A', job_type: 'research' } })
		).rejects.toThrow('Add a step.');
		await expect(
			run({ type: 'jobs.create', job: { name: 'A', job_type: 'nope' as 'research' } })
		).rejects.toThrow('no job type nope: one of research, guided_planning, autonomous_coding');
		expect(jobsStore.createJob).not.toHaveBeenCalled();
	});

	it('makes research jobs alone in lean mode, and still edits a paused one', async () => {
		job(1, { job_type: 'guided_planning', name: 'Plan' });
		lean.on = true;
		await expect(
			run({ type: 'jobs.create', job: { name: 'P', job_type: 'guided_planning' } })
		).rejects.toThrow('Lean mode is on: only research jobs can be made.');
		await expect(
			run({ type: 'jobs.update', jobId: 1, job: { name: 'Plan again' } })
		).resolves.toEqual({ jobId: 1 });
		await expect(
			run({ type: 'jobs.create', job: { name: 'R', job_type: 'research' }, steps: ['x'] })
		).resolves.toHaveProperty('jobId');
	});

	it('refuses an inline API key and a column the app owns', async () => {
		await expect(
			run({
				type: 'jobs.create',
				job: { name: 'A', job_type: 'research', model_remote_api_key: 'sk' } as never,
				steps: ['x']
			})
		).rejects.toThrow('model_remote_api_key_id');
		await expect(
			run({
				type: 'jobs.create',
				job: { name: 'A', job_type: 'research', auto_approve_tools: false } as never,
				steps: ['x']
			})
		).rejects.toThrow('a job has no field auto_approve_tools');
	});

	it('schedules a type that can be, and refuses one that asks questions', async () => {
		const { jobId } = await run({
			type: 'jobs.create',
			job: { name: 'Daily', job_type: 'research' },
			steps: ['x'],
			schedule: { kind: 'daily', time: '09:30' }
		});
		const saved = fake.jobs.find((j) => j.id === jobId)!;
		expect(saved.schedule_kind).toBe('daily');
		expect(saved.next_due_at).toBeGreaterThan(Date.now());
		await expect(
			run({
				type: 'jobs.create',
				job: { name: 'Plan', job_type: 'guided_planning' },
				schedule: { kind: 'hourly' }
			})
		).rejects.toThrow("a Guided planning job can't be scheduled");
		await expect(
			run({
				type: 'jobs.create',
				job: { name: 'Bad', job_type: 'research' },
				steps: ['x'],
				schedule: { kind: 'daily', time: '9am' }
			})
		).rejects.toThrow('a schedule is');
	});

	it('updates only what it names, keeping the steps, the config and the inline key', async () => {
		job(1, { type_config: '{"depth":3}', model_remote_api_key: 'sk-inline' });
		await run({ type: 'jobs.update', jobId: 1, job: { name: 'Renamed' }, config: { more: 1 } });
		const saved = fake.jobs.find((j) => j.id === 1)!;
		expect(saved).toMatchObject({
			name: 'Renamed',
			type_config: '{"depth":3,"more":1}',
			model_remote_api_key: 'sk-inline'
		});
		expect(saved.steps.map((s) => s.prompt)).toEqual(['Find it']);
		expect(jobsStore.replaceJobSteps).not.toHaveBeenCalled();
		await run({ type: 'jobs.update', jobId: 1, steps: ['New step'] });
		expect(saved.steps.map((s) => s.prompt)).toEqual(['New step']);
	});

	it('duplicates a job', async () => {
		job(1);
		const { jobId } = await run({ type: 'jobs.duplicate', jobId: 1 });
		expect(fake.jobs.find((j) => j.id === jobId)?.name).toBe('Job 1 (copy)');
	});

	it("won't delete a job while its run is running, and takes its queued runs out first", async () => {
		job(1);
		job(2);
		running(50, 1);
		await expect(run({ type: 'jobs.delete', jobId: 1 })).rejects.toThrow(
			'run 50 of this job is running'
		);
		fake.queue = [{ runId: 51, jobId: 2, jobName: 'Job 2', trigger: 'manual' }];
		expect(await run({ type: 'jobs.delete', jobId: 2 })).toEqual({ deleted: 2, dequeued: 1 });
		expect(fake.queue).toEqual([]);
		expect(fake.jobs.map((j) => j.id)).toEqual([1]);
	});
});

describe('running jobs', () => {
	it('runs a job now, or queues it behind the one running', async () => {
		job(1);
		job(2);
		expect(await run({ type: 'jobs.run', jobId: 1 })).toEqual({ runId: 100, queued: false });
		expect(await run({ type: 'jobs.run', jobId: 2 })).toEqual({ runId: 101, queued: true });
	});

	it('says why a job cannot run', async () => {
		job(1, { steps: [] });
		job(2, { job_type: 'autonomous_coding' });
		await expect(run({ type: 'jobs.run', jobId: 1 })).rejects.toThrow('the job has no steps');
		await expect(run({ type: 'jobs.run', jobId: 2 })).rejects.toThrow(
			"Autonomous coding jobs can't run on this computer"
		);
	});

	it('cancels the run in progress, and takes a queued one out as cancelled', async () => {
		job(1);
		running(50, 1);
		expect(await run({ type: 'run.cancel', runId: 50 })).toEqual({ cancelling: true });
		expect(fake.cancelled).toEqual([50]);
		fake.runs[51] = { id: 51, job_id: 1, status: 'queued', steps: [] };
		fake.queue = [{ runId: 51, jobId: 1, jobName: 'Job 1', trigger: 'manual' }];
		expect(await run({ type: 'run.cancel', runId: 51 })).toEqual({ dequeued: true });
		expect(fake.finished).toEqual([{ runId: 51, status: 'cancelled' }]);
	});

	it('reads the run in progress with what only it has: text, reasoning, tool steps', async () => {
		job(1);
		running(50, 1);
		const got = await run({ type: 'runs.get', runId: 50 });
		expect(got.live.steps[0].reasoning).toBe('thinking');
		fake.runs[49] = { id: 49, job_id: 1, status: 'succeeded', steps: [] };
		expect((await run({ type: 'runs.get', runId: 49 })).live).toBeNull();
	});

	it("won't delete a running run", async () => {
		job(1);
		running(50, 1);
		await expect(run({ type: 'runs.delete', runId: 50 })).rejects.toThrow('is running');
		fake.runs[49] = { id: 49, job_id: 1, status: 'succeeded', steps: [] };
		expect(await run({ type: 'runs.delete', runId: 49 })).toEqual({ deleted: 49 });
	});
});

describe('job events', () => {
	it('send the run as it changes, its text coalesced, and the queue', async () => {
		const events: JobEvent[] = [];
		const watcher = watchJobs((e) => events.push(e));
		job(1);
		const r = running(50, 1);
		await settle();
		expect(events.filter((e) => e.type === 'job-run')).toHaveLength(1);

		fake.current!.steps[0].streaming = 'Hel';
		fake.current!.steps[0].streaming = 'Hello';
		await settle();
		const live = events.filter((e) => e.type === 'job-run-live');
		expect(live.at(-1)).toMatchObject({ runId: 50, stepIndex: 0, streaming: 'Hello' });
		expect(live).toHaveLength(1);

		fake.current = { ...r, status: 'succeeded', finishedAt: 2 };
		await settle();
		const last = events.filter((e) => e.type === 'job-run').at(-1);
		expect(last).toMatchObject({ runId: 50, run: { status: 'succeeded' } });
		// One seq per run, in order.
		const seqs = events.filter((e) => 'runId' in e).map((e) => e.seq);
		expect(seqs).toEqual(seqs.map((_, i) => i + 1));

		fake.queue = [{ runId: 51, jobId: 1, jobName: 'Job 1', trigger: 'manual' }];
		await settle();
		expect(events.at(-1)).toMatchObject({ type: 'job-queue', seq: 1, queue: [{ runId: 51 }] });
		watcher.stop();
	});

	it('resend the current run on resync', async () => {
		const events: JobEvent[] = [];
		const watcher = watchJobs((e) => events.push(e));
		job(1);
		running(50, 1);
		await settle();
		const before = events.length;
		expect(await run({ type: 'runs.resync', runId: 50 })).toEqual({ resynced: 50 });
		expect(events.length).toBe(before + 1);
		await expect(run({ type: 'runs.resync', runId: 49 })).rejects.toThrow("isn't the current run");
		watcher.stop();
	});
});
