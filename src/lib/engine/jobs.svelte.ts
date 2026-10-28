/**
 * The Jobs tab, for clients other than the main window's own (#744): list,
 * write, run and cancel jobs, read their runs, and follow the run in
 * progress as events.
 *
 * It drives the same stores and runner the tab does, so a job made here is
 * the job the tab shows, and runs queue together. The tab's own rules hold:
 * jobs always auto-approve their tools, a job can't be deleted while one of
 * its runs is running, and a queued run leaves the queue before its row goes.
 * The inline API key column never crosses: a read blanks it, and a write
 * takes a key from the API-key store by id instead.
 *
 * Main window only; job ops name no Code session, so the hub sends them here.
 */
import { untrack } from 'svelte';
import {
	cancel,
	enqueue,
	getCurrentRun,
	getPendingQueue,
	getRunningRunId,
	removeQueuedRun,
	removeQueuedRunsForJob,
	type RunState
} from '#lib/agent/jobs/runner.svelte.ts';
import { getJobType, listJobTypes } from '#lib/agent/jobs/types/index.ts';
import type { JobTypeDefinition } from '#lib/agent/jobs/types/types.ts';
import {
	computeNextDueAt,
	configJsonToSchedule,
	createJob,
	deleteJob,
	duplicateJob,
	getJob,
	getJobs,
	loadJobs,
	replaceJobSteps,
	scheduleToConfigJson,
	updateJob,
	type JobInput,
	type JobStepInput,
	type JobWithSteps,
	type Schedule
} from '#lib/stores/jobs.svelte.ts';
import {
	deleteJobRun,
	getJobRun,
	getRunsForJob,
	loadRunsForJob,
	markRunFinished
} from '#lib/stores/jobRuns.svelte.ts';
import { LIVE_MS } from '#lib/engine/watch.svelte.ts';
import type { JobEvent, JobFields, JobOp, JobRunLive, JobStepWrite } from '#lib/engine/types.ts';

/** Plain data, whatever Svelte's proxies make of it. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

/** The columns a client may write. Everything else the app owns. */
const WRITABLE: (keyof JobFields)[] = [
	'name',
	'description',
	'working_dir',
	'job_type',
	'model_remote_base_url',
	'model_remote_api_key_id',
	'model_remote_model_id',
	'model_remote_context_size',
	'model_remote_vision_supported',
	'model_advanced'
];

function typeOf(id: string): JobTypeDefinition {
	const def = getJobType(id);
	if (!def) {
		const known = listJobTypes().map((t) => t.id);
		throw new Error(`no job type ${id}: one of ${known.join(', ')}`);
	}
	return def;
}

async function mustGet(jobId: number): Promise<JobWithSteps> {
	const job = await getJob(jobId);
	if (!job) throw new Error(`no job ${jobId}`);
	return job;
}

/** A job as a client reads it: its type's config parsed, the inline key blanked. */
function jobOut(job: JobWithSteps) {
	const def = getJobType(job.job_type);
	return {
		...plain(job),
		model_remote_api_key: null,
		has_inline_api_key: !!job.model_remote_api_key,
		config: def ? def.configFromJob(job.type_config) : null,
		schedule: configJsonToSchedule(job.schedule_kind, job.schedule_config)
	};
}

function pickFields(fields: Record<string, unknown> | undefined): JobFields {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fields ?? {})) {
		if (k === 'model_remote_api_key') {
			throw new Error(
				'a job takes its API key from Settings → Inference → API Keys: send model_remote_api_key_id'
			);
		}
		if (!WRITABLE.includes(k as keyof JobFields)) throw new Error(`a job has no field ${k}`);
		out[k] = v;
	}
	return out as JobFields;
}

function stepsIn(def: JobTypeDefinition, steps: JobStepWrite[]): JobStepInput[] {
	const all = steps.map((s) =>
		typeof s === 'string'
			? { prompt: s, deep_research: false }
			: { prompt: s.prompt ?? '', deep_research: s.deep_research === true }
	);
	return def.persistSteps
		? def.persistSteps(all)
		: all
				.map((s) => ({ prompt: s.prompt.trim(), deep_research: s.deep_research }))
				.filter((s) => s.prompt.length > 0);
}

/** The schedule's columns, as the editor saves them: a schedule edit restarts its cadence. */
function scheduleColumns(def: JobTypeDefinition, schedule: Schedule) {
	if (schedule.kind !== 'manual' && def.supportsSchedule === false) {
		throw new Error(`a ${def.label} job can't be scheduled: it asks questions as it runs`);
	}
	const time = 'time' in schedule ? schedule.time : null;
	const known =
		configJsonToSchedule(schedule.kind, scheduleToConfigJson(schedule)) !== null &&
		(time === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) &&
		(schedule.kind !== 'interval' || (Number.isInteger(schedule.minutes) && schedule.minutes > 0));
	if (!known) {
		throw new Error(
			'a schedule is {kind:"manual"|"hourly"}, {kind:"daily",time:"HH:MM"}, ' +
				'{kind:"weekly",day:"mon",time:"HH:MM"} or {kind:"interval",minutes:N}'
		);
	}
	return {
		schedule_kind: schedule.kind,
		schedule_config: scheduleToConfigJson(schedule),
		next_due_at: computeNextDueAt(schedule, null)
	};
}

interface JobWrite {
	job?: Record<string, unknown>;
	steps?: JobStepWrite[];
	config?: Record<string, unknown>;
	schedule?: Schedule;
}

/** A new job's stored columns, before a write lays its fields over them. */
const BLANK: Omit<JobInput, 'job_type' | 'auto_approve_tools' | 'type_config'> = {
	name: '',
	description: null,
	working_dir: '',
	schedule_kind: 'manual',
	schedule_config: null,
	next_due_at: null,
	model_remote_base_url: null,
	model_remote_api_key: null,
	model_remote_api_key_id: null,
	model_remote_model_id: null,
	model_remote_context_size: null,
	model_remote_vision_supported: null,
	model_advanced: null
};

/** A job's stored columns, or a new job's. */
function storedColumns(existing: JobWithSteps | null): typeof BLANK {
	if (!existing) return { ...BLANK };
	return Object.fromEntries(
		Object.keys(BLANK).map((k) => [k, existing[k as keyof typeof BLANK]])
	) as typeof BLANK;
}

/** The job's type and config: the write's config over the job's, or the type's defaults. */
function typeAndConfig(existing: JobWithSteps | null, fields: JobFields, w: JobWrite) {
	const jobType = fields.job_type ?? existing?.job_type;
	if (!jobType) throw new Error('a new job needs a job_type (see jobs.types)');
	const def = typeOf(jobType);
	const keep = existing?.job_type === jobType;
	const base = keep ? def.configFromJob(existing!.type_config) : def.configDefaults();
	return { jobType, def, config: { ...base, ...(w.config ?? {}) } };
}

/** Save it: an update, or a create. The job's id. */
async function save(existing: JobWithSteps | null, input: JobInput): Promise<number> {
	if (existing) {
		if (!(await updateJob(existing.id, input))) throw new Error(`couldn't save job ${existing.id}`);
		return existing.id;
	}
	const created = await createJob(input);
	if (created === null) throw new Error("couldn't create the job");
	return created;
}

/**
 * Create a job, or lay a write over one: the fields it names, its config over
 * the job's (or the type's defaults), and its steps when given. Checked as the
 * editor checks a save.
 */
async function writeJob(existing: JobWithSteps | null, w: JobWrite): Promise<number> {
	const fields = pickFields(w.job);
	const { jobType, def, config } = typeAndConfig(existing, fields, w);
	const steps = w.steps
		? stepsIn(def, w.steps)
		: (existing?.steps ?? []).map((s) => ({ prompt: s.prompt, deep_research: s.deep_research }));

	const input: JobInput = {
		...storedColumns(existing),
		...fields,
		job_type: jobType,
		// Jobs always run unattended, so their tool calls are auto-approved.
		auto_approve_tools: true,
		type_config: def.configToJson(config)
	};
	input.name = input.name.trim();
	if (w.schedule) Object.assign(input, scheduleColumns(def, w.schedule));
	else if (def.supportsSchedule === false)
		Object.assign(input, scheduleColumns(def, { kind: 'manual' }));

	if (!input.name) throw new Error('a job needs a name');
	const invalid = def.validate?.({
		name: input.name,
		workingDir: input.working_dir,
		steps,
		config
	});
	if (invalid) throw new Error(invalid);

	const id = await save(existing, input);
	if ((w.steps || !existing) && !(await replaceJobSteps(id, steps))) {
		throw new Error(`saved job ${id} but couldn't save its steps`);
	}
	return id;
}

/** Why `enqueue` would refuse, said rather than logged. */
async function runRefusal(job: JobWithSteps): Promise<string | null> {
	const def = getJobType(job.job_type);
	if (!def) return `job type ${job.job_type} isn't registered`;
	if (def.available && !(await def.available())) {
		return `${def.label} jobs can't run on this computer`;
	}
	if (def.hasPlannedSteps && job.steps.length === 0) return 'the job has no steps';
	return null;
}

/** The run in progress as events carry it: everything but the text and the tool steps. */
export function runLive(run: RunState): JobRunLive {
	return {
		id: run.id,
		jobId: run.jobId,
		jobName: run.jobName,
		jobType: run.jobType,
		status: run.status,
		error: run.error,
		currentStepIndex: run.currentStepIndex,
		waitingForSlot: run.waitingForSlot,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		steps: run.steps.map((s) => ({
			index: s.index,
			description: s.description,
			promptAuthored: s.promptAuthored,
			status: s.status,
			output: s.output,
			error: s.error,
			usage: plain(s.usage),
			toolCalls: s.searchSteps.length,
			startedAt: s.startedAt,
			finishedAt: s.finishedAt
		}))
	};
}

async function runOf(runId: number) {
	const run = await getJobRun(runId);
	if (!run) throw new Error(`no run ${runId}`);
	return run;
}

export async function dispatchJobs(op: JobOp): Promise<unknown> {
	switch (op.type) {
		case 'jobs.types':
			return Promise.all(
				listJobTypes().map(async (t) => ({
					id: t.id,
					label: t.label,
					description: t.description,
					hasPlannedSteps: t.hasPlannedSteps,
					schedulable: t.supportsSchedule !== false,
					available: t.available ? await t.available() : true,
					configDefaults: t.configDefaults()
				}))
			);
		case 'jobs.list':
			await loadJobs();
			return plain(getJobs());
		case 'jobs.get':
			return jobOut(await mustGet(op.jobId));
		case 'jobs.create':
			return { jobId: await writeJob(null, op) };
		case 'jobs.update':
			return { jobId: await writeJob(await mustGet(op.jobId), op) };
		case 'jobs.duplicate': {
			await mustGet(op.jobId);
			const id = await duplicateJob(op.jobId);
			if (id === null) throw new Error(`couldn't duplicate job ${op.jobId}`);
			return { jobId: id };
		}
		case 'jobs.delete': {
			await mustGet(op.jobId);
			const running = getCurrentRun();
			if (running?.status === 'running' && running.jobId === op.jobId) {
				throw new Error(`run ${running.id} of this job is running: cancel it first`);
			}
			// Out of the queue first, so none of its runs starts in between.
			const dequeued = removeQueuedRunsForJob(op.jobId);
			if (!(await deleteJob(op.jobId))) throw new Error(`couldn't delete job ${op.jobId}`);
			return { deleted: op.jobId, dequeued };
		}
		case 'jobs.run': {
			const job = await mustGet(op.jobId);
			const refusal = await runRefusal(job);
			if (refusal) throw new Error(refusal);
			const runId = await enqueue(op.jobId, op.trigger ?? 'manual');
			if (runId === null) throw new Error(`job ${op.jobId} didn't start: see the debug log`);
			return { runId, queued: getRunningRunId() !== runId };
		}
		case 'run.cancel': {
			if (getRunningRunId() === op.runId) {
				cancel(op.runId);
				return { cancelling: true };
			}
			if (removeQueuedRun(op.runId)) {
				const run = await runOf(op.runId);
				await markRunFinished(op.runId, run.job_id, 'cancelled', Date.now(), null);
				return { dequeued: true };
			}
			await runOf(op.runId);
			return { cancelling: false };
		}
		case 'runs.list':
			await mustGet(op.jobId);
			await loadRunsForJob(op.jobId);
			return plain(getRunsForJob(op.jobId));
		case 'runs.get': {
			const run = await runOf(op.runId);
			const current = getCurrentRun();
			// The run in progress has what the database doesn't keep: the text
			// being written, reasoning and the tool steps.
			return { ...plain(run), live: current?.id === op.runId ? plain(current) : null };
		}
		case 'runs.current': {
			const current = getCurrentRun();
			return { run: current ? runLive(current) : null, queue: plain(getPendingQueue()) };
		}
		case 'runs.delete': {
			if (getRunningRunId() === op.runId) {
				throw new Error(`run ${op.runId} is running: cancel it first`);
			}
			const run = await runOf(op.runId);
			removeQueuedRun(op.runId);
			if (!(await deleteJobRun(run.job_id, op.runId))) {
				throw new Error(`couldn't delete run ${op.runId}`);
			}
			return { deleted: op.runId };
		}
		case 'runs.resync':
			if (!resyncRun?.(op.runId)) throw new Error(`run ${op.runId} isn't the current run`);
			return { resynced: op.runId };
		default:
			throw new Error(`unknown operation ${(op as { type?: string }).type}`);
	}
}

// --- events -----------------------------------------------------------------

let resyncRun: ((runId: number) => boolean) | null = null;

/**
 * Turn the runner into events: a `job-run` whenever the current run changes
 * other than its text, its running step's text as `job-run-live` coalesced to
 * one per `LIVE_MS`, and `job-queue` whenever the queue changes.
 */
export function watchJobs(sink: (e: JobEvent) => void): { stop: () => void } {
	// Bookkeeping, never rendered: not a SvelteMap.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const seqs = new Map<number, number>();
	const nextSeq = (runId: number) => {
		const seq = (seqs.get(runId) ?? 0) + 1;
		seqs.set(runId, seq);
		return seq;
	};
	let queueSeq = 0;
	let lastRun = '';
	let lastQueue = '[]';
	/** The text last sent, so a step's text goes out only when it changes. */
	let lastLive = '';
	let liveTimer: ReturnType<typeof setTimeout> | null = null;

	const liveOf = (run: RunState) => {
		const step = run.steps[run.currentStepIndex];
		return { stepIndex: run.currentStepIndex, streaming: step?.streaming ?? '' };
	};
	const liveKey = (run: RunState) => JSON.stringify([run.id, liveOf(run)]);
	const sendLive = () => {
		const run = getCurrentRun();
		if (!run || liveKey(run) === lastLive) return;
		lastLive = liveKey(run);
		sink({ type: 'job-run-live', seq: nextSeq(run.id), runId: run.id, ...liveOf(run) });
	};
	const flushLive = () => {
		if (liveTimer === null) return;
		clearTimeout(liveTimer);
		liveTimer = null;
		sendLive();
	};
	const sendRun = (run: RunState) => {
		flushLive();
		const live = runLive(run);
		lastRun = JSON.stringify(live);
		// A new run or step starts with no text: nothing to send until it has some.
		if (!liveOf(run).streaming) lastLive = liveKey(run);
		sink({ type: 'job-run', seq: nextSeq(run.id), runId: run.id, run: live });
	};
	resyncRun = (runId) => {
		const run = getCurrentRun();
		if (!run || run.id !== runId) return false;
		sendRun(run);
		return true;
	};

	const stopRoot = $effect.root(() => {
		$effect(() => {
			const run = getCurrentRun();
			const key = run ? JSON.stringify(runLive(run)) : '';
			untrack(() => {
				if (run && key !== lastRun) sendRun(run);
				if (!run) lastRun = '';
			});
		});

		$effect(() => {
			const run = getCurrentRun();
			if (!run) return;
			const key = liveKey(run);
			untrack(() => {
				if (key === lastLive) return;
				liveTimer ??= setTimeout(() => {
					liveTimer = null;
					sendLive();
				}, LIVE_MS);
			});
		});

		$effect(() => {
			const queue = plain(getPendingQueue());
			const key = JSON.stringify(queue);
			untrack(() => {
				if (key === lastQueue) return;
				lastQueue = key;
				sink({ type: 'job-queue', seq: ++queueSeq, queue });
			});
		});
	});

	return {
		stop: () => {
			stopRoot();
			if (liveTimer !== null) clearTimeout(liveTimer);
			liveTimer = null;
			resyncRun = null;
		}
	};
}
