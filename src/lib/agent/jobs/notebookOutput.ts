/**
 * Saving a run's results to a notebook by itself, for a job type that can
 * make notebook cards from its result (`notebookCards` on its definition).
 * The choice is kept in the job's `type_config` under `notebook_output`, the
 * same key for every such type, so the runner reads it without knowing the
 * type's own config. A job that keeps one notebook up to date also keeps its
 * id there, under `notebook_output_id`, once its first run has made it.
 */
import * as api from '#lib/notebooks/api.ts';
import type {
	NewCard,
	NotebookCard,
	NotebookSource,
	NotebookSummary,
	RowOp
} from '#lib/notebooks/api.ts';
import type { Column } from '#lib/notebooks/columns.ts';
import { getJob, updateJob } from '#lib/stores/jobs.svelte.ts';
import { modelColumnsOf } from '#lib/agent/jobs/chainModel.ts';

export const NOTEBOOK_OUTPUT_KEY = 'notebook_output';
export const NOTEBOOK_ID_KEY = 'notebook_output_id';

/**
 * Off, a new notebook for each successful run, or one notebook each run
 * updates (for a type with `notebookUpdate`).
 */
export const NOTEBOOK_OUTPUT_MODES = ['off', 'new', 'one'] as const;
export type NotebookOutputMode = (typeof NOTEBOOK_OUTPUT_MODES)[number];

/** A stored value as a mode; anything else is off. */
export function parseNotebookOutput(raw: unknown): NotebookOutputMode {
	return NOTEBOOK_OUTPUT_MODES.includes(raw as NotebookOutputMode)
		? (raw as NotebookOutputMode)
		: 'off';
}

function configOf(typeConfig: string | null): Record<string, unknown> {
	if (!typeConfig) return {};
	try {
		const parsed: unknown = JSON.parse(typeConfig);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Keys a run writes into its own job's `type_config`. The job editor's copy
 * may be older than the run, so its save keeps these from the stored job.
 */
const RUN_WRITTEN_KEYS = [NOTEBOOK_ID_KEY];

/** `next` (the editor's `type_config`) with the run-written keys `stored` holds. */
export function keepRunWritten(next: string | null, stored: string | null): string | null {
	const kept = configOf(stored);
	const keys = RUN_WRITTEN_KEYS.filter((k) => kept[k] !== undefined && kept[k] !== null);
	if (keys.length === 0) return next;
	return JSON.stringify({
		...configOf(next),
		...Object.fromEntries(keys.map((k) => [k, kept[k]]))
	});
}

/** The mode a job's `type_config` JSON holds. */
export function readNotebookOutput(typeConfig: string | null): NotebookOutputMode {
	return parseNotebookOutput(configOf(typeConfig)[NOTEBOOK_OUTPUT_KEY]);
}

/** The notebook a job keeps up to date, once its first run has made it. */
export function readNotebookId(typeConfig: string | null): string | null {
	const id = configOf(typeConfig)[NOTEBOOK_ID_KEY];
	return typeof id === 'string' && id.trim() ? id : null;
}

/** "Audit · 27 Nov 2026, 14:05": the job, and when the run finished. */
export function runNotebookTitle(jobName: string, at: Date): string {
	const when = at.toLocaleString(undefined, {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
	return `${jobName.trim() || 'Job'} · ${when}`;
}

export interface RunNotebookInput {
	jobId: number;
	jobName: string;
	runId: number;
	cards: NewCard[];
	finishedAt: Date;
}

/**
 * Make a notebook for one run and add its cards, each from that run. Null
 * when there are no cards. A notebook whose cards fail partway is kept with
 * what was added, and the error is thrown.
 */
export async function saveRunToNewNotebook(
	input: RunNotebookInput
): Promise<NotebookSummary | null> {
	if (input.cards.length === 0) return null;
	const notebook = await api.createNotebook(runNotebookTitle(input.jobName, input.finishedAt));
	const source: NotebookSource = {
		kind: 'job',
		ref: `${input.jobId}:${input.runId}`,
		label: input.jobName
	};
	for (const card of input.cards) await api.addCard(notebook.id, card, source);
	return notebook;
}

/**
 * One change a run makes to the notebook it keeps up to date: add a card at
 * the end, replace a text card's body, or change a table's columns and rows.
 * `version` is the card's as it was read, so a change made in the meantime
 * is caught.
 */
export type NotebookStep =
	| { op: 'add'; card: NewCard }
	| { op: 'body'; cardId: string; version: number; body: string }
	| { op: 'rows'; cardId: string; version: number; columns?: Column[]; rows: RowOp[] };

/** The changes to make, from the notebook's live cards (all their rows read). */
export type NotebookUpdate = (
	cards: NotebookCard[],
	result: unknown,
	finishedAt: Date
) => NotebookStep[];

/** Cards with every row read: a card from `getNotebook` carries only the first few. */
async function withAllRows(cards: NotebookCard[]): Promise<NotebookCard[]> {
	return Promise.all(
		cards.map(async (c) =>
			c.rows.length < c.row_count ? { ...c, rows: await api.getRows(c.id, 0, c.row_count) } : c
		)
	);
}

async function applySteps(
	notebookId: string,
	steps: NotebookStep[],
	source: NotebookSource
): Promise<void> {
	for (const s of steps) {
		if (s.op === 'add') {
			await api.addCard(notebookId, s.card, source);
		} else if (s.op === 'body') {
			await api.updateCard(s.cardId, s.version, { body: s.body }, source);
		} else {
			let version = s.version;
			if (s.columns) version = (await api.setColumns(s.cardId, version, s.columns, source)).version;
			if (s.rows.length) await api.applyRows(s.cardId, version, s.rows, source);
		}
	}
}

/** Keep `fields` in a stored job's `type_config`, beside what is there. */
async function rememberInJob(jobId: number, fields: Record<string, unknown>): Promise<boolean> {
	const job = await getJob(jobId);
	if (!job) return false;
	return updateJob(jobId, {
		name: job.name,
		description: job.description,
		working_dir: job.working_dir,
		auto_approve_tools: job.auto_approve_tools,
		job_type: job.job_type,
		schedule_kind: job.schedule_kind,
		schedule_config: job.schedule_config,
		next_due_at: job.next_due_at,
		...modelColumnsOf(job),
		type_config: JSON.stringify({ ...configOf(job.type_config), ...fields })
	});
}

export interface JobNotebookInput {
	jobId: number;
	jobName: string;
	runId: number;
	/** The job's `type_config` as the run read it: where the notebook's id is. */
	typeConfig: string | null;
	result: unknown;
	update: NotebookUpdate;
	finishedAt: Date;
}

/**
 * Bring the job's notebook up to date with this run, or make it when the job
 * has none yet (or it was deleted) and remember it on the job. If a card
 * changed while this read it, it reads and tries once more.
 */
export async function updateJobNotebook(
	input: JobNotebookInput
): Promise<{ notebook: NotebookSummary; created: boolean } | null> {
	const source: NotebookSource = {
		kind: 'job',
		ref: `${input.jobId}:${input.runId}`,
		label: input.jobName
	};
	const id = readNotebookId(input.typeConfig);
	for (let attempt = 0; ; attempt++) {
		const detail = id ? await api.getNotebook(id).catch(() => null) : null;
		if (!detail || detail.notebook.deleted_at !== null) {
			const steps = input.update([], input.result, input.finishedAt);
			if (steps.length === 0) return null;
			const notebook = await api.createNotebook(input.jobName.trim() || 'Job');
			await applySteps(notebook.id, steps, source);
			if (!(await rememberInJob(input.jobId, { [NOTEBOOK_ID_KEY]: notebook.id }))) {
				console.warn('Could not keep the notebook on the job; the next run makes another.');
			}
			return { notebook, created: true };
		}
		const cards = await withAllRows(detail.cards.filter((c) => c.deleted_at === null));
		try {
			await applySteps(
				detail.notebook.id,
				input.update(cards, input.result, input.finishedAt),
				source
			);
			return { notebook: detail.notebook, created: false };
		} catch (e) {
			if (attempt > 0 || !api.isConflict(e)) throw e;
		}
	}
}

export interface RunResultsInput {
	job: { id: number; name: string; type_config: string | null };
	runId: number;
	result: unknown;
	cards: (result: unknown) => NewCard[];
	update?: NotebookUpdate;
	finishedAt: Date;
}

/**
 * Save a run's results as its job's `notebook_output` says: the notebook it
 * went to and what to tell the user, or null when nothing was saved.
 */
export async function saveRunResults(
	input: RunResultsInput
): Promise<{ notebook: NotebookSummary; message: string } | null> {
	const { job, runId, result, finishedAt } = input;
	const mode = readNotebookOutput(job.type_config);
	if (mode === 'one' && input.update) {
		// Read the job again: an earlier run may have just made its notebook.
		const fresh = await getJob(job.id);
		const kept = await updateJobNotebook({
			jobId: job.id,
			jobName: job.name,
			runId,
			typeConfig: fresh?.type_config ?? job.type_config,
			result,
			update: input.update,
			finishedAt
		});
		if (!kept) return null;
		const { notebook } = kept;
		return {
			notebook,
			message: kept.created
				? `Saved ${job.name}'s results to a new notebook, ${notebook.title}.`
				: `Updated ${notebook.title} with ${job.name}'s results.`
		};
	}
	if (mode !== 'new') return null;
	const notebook = await saveRunToNewNotebook({
		jobId: job.id,
		jobName: job.name,
		runId,
		cards: input.cards(result),
		finishedAt
	});
	return notebook
		? { notebook, message: `Saved ${job.name}'s results to ${notebook.title}.` }
		: null;
}
